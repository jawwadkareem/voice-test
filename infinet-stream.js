// server-stream.js
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegStatic);

const PORT = process.env.STREAM_PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// simple in-memory session state
const sessions = new Map();
// config: how often server will flush buffered audio for partial STT (ms)
const PARTIAL_FLUSH_MS = 1000; // 1 second default (tune lower/higher)

// helper to write Buffer of webm/ogg/opus to disk and convert to wav
async function convertBlobsToWav(blobs, outWavPath) {
  // blobs: array of Buffer (webm/ogg)
  const tmpIn = outWavPath + ".in";
  await fs.promises.writeFile(tmpIn, Buffer.concat(blobs));
  return new Promise((resolve, reject) => {
    ffmpeg(tmpIn)
      .outputOptions(["-ar 16000", "-ac 1", "-vn"])
      .toFormat("wav")
      .on("end", async () => {
        try { await fs.promises.unlink(tmpIn); } catch(_){}
        resolve(outWavPath);
      })
      .on("error", (err) => reject(err))
      .save(outWavPath);
  });
}

// Transcribe wav file with OpenAI (non-streaming). This returns text.
async function transcribeWavFile(wavPath) {
  const resp = await openai.audio.transcriptions.create({
    file: fs.createReadStream(wavPath),
    model: "gpt-4o-mini-transcribe"
  });
  return resp?.text || "";
}

// Generate TTS mp3 (full reply) and return Buffer
async function synthesizeSpeech(text) {
  const tts = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "cedar",
    input: text,
    format: "mp3"
  });
  // streamToBuffer logic (supports Response-like)
  if (Buffer.isBuffer(tts)) return tts;
  if (tts.arrayBuffer) {
    const ab = await tts.arrayBuffer();
    return Buffer.from(ab);
  }
  // fallback - try to read stream
  const chunks = [];
  return new Promise((resolve, reject) => {
    tts.on("data", c => chunks.push(Buffer.from(c)));
    tts.on("end", () => resolve(Buffer.concat(chunks)));
    tts.on("error", reject);
  });
}

// prepare simple chat reply using current session messages (quick, no function calling)
async function quickAssistantReply(session, userText) {
  // push user partial as a message
  session.messages.push({ role: "user", content: userText });
  // quick system hint to be concise
  const msgs = [
    { role: "system", content: "You are a concise assistant. Keep replies short." },
    ...session.messages
  ];
  const finalResp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: msgs,
    temperature: 0.0,
    max_tokens: 120
  });
  const assistantText = finalResp.choices?.[0]?.message?.content?.trim() || "";
  session.messages.push({ role: "assistant", content: assistantText });
  return assistantText;
}

// create HTTP server (for WebSocket upgrade)
const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  // You can add auth checks here using req headers
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const sid = uuidv4();
  // maintain state: buffer of audio blobs, lastFlush, messages for chat
  const session = {
    id: sid,
    ws,
    blobBuffer: [],     // array of Buffer for webm blobs until flush
    lastFlushAt: Date.now(),
    messages: [ { role: "system", content: "You are a concise voice assistant." } ],
    timer: null
  };
  sessions.set(sid, session);

  // periodic flush timer (also flushed when buffer size grows)
  session.timer = setInterval(async () => {
    if (session.blobBuffer.length === 0) return;
    await flushBufferForSession(session).catch(err => console.error("flush err:", err));
  }, PARTIAL_FLUSH_MS);

  ws.on("message", async (msg) => {
    // messages are JSON prefixed or raw binary blobs
    if (typeof msg === "string") {
      // control messages: JSON
      let obj;
      try { obj = JSON.parse(msg); } catch(e) { return; }
      if (obj.type === "init") {
        // client sent initial consent/session info
        session.clientSessionId = obj.sessionId || null;
        session.consent = obj.consent === true || obj.consent === "true";
        // echo back assigned sid for server-side mapping
        ws.send(JSON.stringify({ type: "server_session", sid: session.id }));
      } else if (obj.type === "flush") {
        // client asks immediate flush
        await flushBufferForSession(session).catch(e => console.error(e));
      }
      return;
    }

    // binary chunk (WebM/opus) -> append to buffer
    if (Buffer.isBuffer(msg)) {
      session.blobBuffer.push(msg);
      // if buffer gets big in bytes, flush earlier for lower latency
      const totalBytes = session.blobBuffer.reduce((s,b)=>s+b.length,0);
      if (totalBytes > 250_000) { // ~250KB threshold -> flush now (tweak)
        await flushBufferForSession(session).catch(err => console.error("flush err:", err));
      }
    }
  });

  ws.on("close", () => {
    clearInterval(session.timer);
    sessions.delete(session.id);
  });
});

// flush buffer -> create wav -> transcribe -> send partial to client -> quick assistant reply -> send TTS
async function flushBufferForSession(session) {
  if (session.blobBuffer.length === 0) return;
  // write fused temp file
  const outDir = path.resolve("./tmp_stream");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const wavPath = path.join(outDir, `${session.id}_${Date.now()}.wav`);
  try {
    await convertBlobsToWav(session.blobBuffer, wavPath);
  } catch (err) {
    console.error("convert error", err);
    session.blobBuffer = [];
    return;
  }
  // clear buffer immediately to accept new audio
  session.blobBuffer = [];

  // transcribe
  let partialText = "";
  try {
    partialText = await transcribeWavFile(wavPath);
  } catch (err) {
    console.error("transcribe error", err);
  } finally {
    try { fs.unlinkSync(wavPath); } catch(_) {}
  }

  if (!partialText) return;

  // send partial transcript (so UI can show it immediately)
  if (session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify({ type: "partial_transcript", text: partialText }));
  }

  // quick assistant reply (cheap LLM call)
  let assistantText = "";
  try {
    assistantText = await quickAssistantReply(session, partialText);
  } catch (err) {
    console.error("assistant error", err);
  }

  if (assistantText) {
    // send assistant partial text
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: "assistant_text", text: assistantText }));
    }
    // synthesize TTS and send audio buffer (mp3) back
    try {
      const ttsBuf = await synthesizeSpeech(assistantText);
      // send in one chunk (client will play it)
      if (session.ws.readyState === WebSocket.OPEN) {
        // send binary with small JSON header to indicate TTS chunk
        const header = Buffer.from(JSON.stringify({ type: "tts_chunk", format: "mp3", size: ttsBuf.length }) + "\n");
        session.ws.send(Buffer.concat([header, ttsBuf]));
      }
    } catch (err) {
      console.error("tts error", err);
    }
  }
}

server.listen(PORT, () => console.log(`Streaming WS server listening on ws://localhost:${PORT}`));