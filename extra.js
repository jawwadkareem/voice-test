import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import OpenAI from "openai";
import { WebSocketServer } from "ws";
import { createServer } from "http";
const { WebSocket } = await import('ws');

dotenv.config();
if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);

// ---------- config ----------
const PORT = process.env.PORT || 3003;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Please set OPENAI_API_KEY in your environment or .env");
  process.exit(1);
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- KB & system prompt ----------
const BRAND = "InfiNET Broadband";
const KB = `...`; // (keep your long KB text here - omitted for brevity in this snippet)
const SYSTEM_PROMPT = `
Start with this greeting: "Thanks for calling ${BRAND}. How may we help you today? Is it sales, support or accounts?"
You are a concise, professional voice/chat assistant for ${BRAND}.
${KB}
`;

// ---------------- helper utilities ----------------
function safeParseJSON(s) {
  try {
    if (!s) return null;
    if (typeof s === "object") return s;
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}
function mkSession(sessionId) {
  const id = sessionId || `s_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const session = {
    id,
    consent: false,
    collected: {},
    messages: [{ role: "system", content: SYSTEM_PROMPT }],
    lastSeen: new Date().toISOString(),
  };
  sessions.set(id, session);
  return session;
}
function normalizeText(t) {
  if (!t) return "";
  return t.toString().replace(/\u200B/g, "").replace(/\s+/g, " ").trim();
}
function numbersToInt(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    if (typeof v === "number") out[k] = Math.round(v);
    else out[k] = v;
  }
  return out;
}
async function streamToBuffer(body) {
  if (!body) return Buffer.from("");
  // If it's already a buffer-like stream or object from OpenAI, attempt common conversions:
  if (Buffer.isBuffer(body)) return body;
  if (body.arrayBuffer) {
    const ab = await body.arrayBuffer();
    return Buffer.from(ab);
  }
  if (body.pipe && typeof body.pipe === "function") {
    const chunks = [];
    return new Promise((resolve, reject) => {
      body.on("data", (c) => chunks.push(Buffer.from(c)));
      body.on("end", () => resolve(Buffer.concat(chunks)));
      body.on("error", (err) => reject(err));
    });
  }
  // fallback stringify
  return Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
}

async function convertToWav(inputPath) {
  const out = inputPath + ".converted.wav";
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(["-ar 16000", "-ac 1", "-vn"])
      .toFormat("wav")
      .on("end", () => resolve(out))
      .on("error", (err) => reject(err))
      .save(out);
  });
}

// ---------------- in-memory sessions ----------------
const sessions = new Map();

// ---------------- function schema (for extraction) ----------------
const extractFunction = {
  type: "function",
  name: "extract_call_fields",
  description:
    "Extract fields from user message: intent (support/sales/general/account), issueSummary, customerName, customerPhone, email, priority, consent (boolean), callbackRequest (boolean), timeline, leadInterest. Omit fields not present.",
  parameters: {
    type: "object",
    properties: {
      intent: { type: "string", enum: ["support", "sales", "general", "account"] },
      issueSummary: { type: "string" },
      customerName: { type: "string" },
      customerPhone: { type: "string" },
      email: { type: "string" },
      priority: { type: "string", enum: ["low","medium","high","urgent"] },
      consent: { type: "boolean" },
      callbackRequest: { type: "boolean" },
      timeline: { type: "string" },
      leadInterest: { type: "string" },
      handover: { type: "boolean" }
    },
    required: []
  }
};

function applyExtractionToSession(session, parsed) {
  const extractionResult = numbersToInt(parsed || {});
  for (const [k, v] of Object.entries(extractionResult)) {
    if (k === "consent" && v === true) session.consent = true;
    else if (v !== undefined && v !== null) session.collected[k] = v;
  }
  session.lastSeen = new Date().toISOString();
  sessions.set(session.id, session);
  return extractionResult;
}

// ---------------- TTS helper ----------------
async function makeTTS(text) {
  try {
    // using OpenAI client to request TTS (API surface can change; this works with streamed responses)
    const tts = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "cedar",
      input: text,
      format: "mp3"
    });
    const buf = await streamToBuffer(tts);
    return buf;
  } catch (err) {
    console.warn("TTS failed:", (err && err.message) || err);
    return null;
  }
}

// ---------------- Splynx/CRM stubs ----------------
const Splynx = {
  async findCustomerByPhone(phone) { return null; },
  async createCustomer(payload) { return { id: "cust_stub_id", ...payload }; },
  async createTicket(payload) { return { id: "ticket_stub_id", ...payload }; },
  async appendTicketMessage(ticketId, message) { return true; }
};

// ---------------- WebSocket (low-latency voice) ----------------
wss.on('connection', (wsClient, req) => {
  // create a fresh session for each client
  const session = mkSession();

  // keep references for cleanup
  let wsOpenAI = null;
  let transcript = '';
  let functionCallId = null;
  let functionArgs = '';
  let keepAliveInterval = null;

  // helper to send safe JSON to client
  const safeClientSend = (obj) => {
    try {
      if (wsClient.readyState === wsClient.OPEN) wsClient.send(JSON.stringify(obj));
    } catch (e) {
      // ignore - client likely closed
    }
  };

  // Connect to OpenAI Realtime
  try {

  wsOpenAI = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );
  } catch (e) {
    console.error("Failed to create OpenAI WS:", e);
    safeClientSend({ type: 'error', error: 'internal_server_error' });
    wsClient.close();
    return;
  }

  // when OpenAI WS opens, configure the session
  wsOpenAI.on('open', () => {
    console.log('OpenAI WS opened for client', session.id);
    // session update: modalities, instructions, tools
    try {
      const payload = {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: SYSTEM_PROMPT,
          voice: 'alloy',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          turn_detection: { type: 'server_vad' },
          temperature: 0.6,
          tools: [extractFunction]
        }
      };
      wsOpenAI.send(JSON.stringify(payload));
    } catch (err) {
      console.warn("Failed to send session.update:", err);
    }

    // optional warm-up user message
    try {
      wsOpenAI.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Hello' }]
        }
      }));
      // request an initial response
      wsOpenAI.send(JSON.stringify({ type: 'response.create' }));
    } catch (err) {
      console.warn("Failed to send warm-up messages:", err);
    }

    // send session id to client
    safeClientSend({ type: 'session_id', sessionId: session.id });

    // keepalive: periodically send a no-op to keep connection alive
    keepAliveInterval = setInterval(() => {
      try {
        if (wsOpenAI && wsOpenAI.readyState === wsOpenAI.OPEN) {
          wsOpenAI.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        }
      } catch (e) {
        // ignore
      }
    }, 30_000);
  });

  wsOpenAI.on('message', (msg) => {
    // messages from OpenAI realtime might be JSON; parse defensively
    const event = safeParseJSON(msg.toString());
    if (!event) return;

    // debug log (comment out in production)
    // console.log('OpenAI event:', event.type);

    try {
      if (event.type === 'error') {
        console.warn('OpenAI error event:', event);
        safeClientSend({ type: 'error', error: event.error || 'openai_error' });
      } else if (event.type === 'response.audio.delta') {
        // event.delta is base64 PCM16 chunk -> forward to client
        safeClientSend({ type: 'audio_delta', delta: event.delta });
      } else if (event.type === 'response.audio.done') {
        safeClientSend({ type: 'audio_done' });
      } else if (event.type === 'conversation.item.created') {
        if (event.item && event.item.type === 'function_call') {
          functionCallId = event.item.id;
          functionArgs = '';
        }
      } else if (event.type === 'response.function_call_arguments.delta') {
        functionArgs += event.delta || '';
      } else if (event.type === 'response.function_call_arguments.done') {
        // parse function args and apply extraction
        const parsed = safeParseJSON(functionArgs);
        const result = applyExtractionToSession(session, parsed || {});
        // acknowledge the function output back to OpenAI
        try {
          wsOpenAI.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: functionCallId,
              output: JSON.stringify(result)
            }
          }));
          // then request a followup response
          wsOpenAI.send(JSON.stringify({ type: 'response.create' }));
        } catch (err) {
          console.warn("Error sending function output to OpenAI:", err);
        }
        functionCallId = null;
        functionArgs = '';
        // send collected to client
        safeClientSend({ type: 'collected', data: session.collected });
      } else if (event.type === 'response.audio_transcript.delta') {
        transcript += event.delta || '';
        safeClientSend({ type: 'transcript_delta', delta: event.delta });
      } else if (event.type === 'response.audio_transcript.done') {
        safeClientSend({ type: 'transcript_done', transcript });
        transcript = '';
      }
    } catch (err) {
      console.warn("Error handling OpenAI event:", err);
    }
  });

  wsOpenAI.on('error', (err) => {
    console.error('OpenAI WS error:', err);
    safeClientSend({ type: 'error', error: 'openai_ws_error' });
  });

  wsOpenAI.on('close', (code, reason) => {
    console.log('OpenAI WS closed:', code, reason && reason.toString ? reason.toString() : reason);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    // notify client and close
    safeClientSend({ type: 'error', error: 'openai_closed' });
    try { if (wsClient && wsClient.readyState === wsClient.OPEN) wsClient.close(); } catch(e){}
  });

  // messages from browser client
  wsClient.on('message', (msg) => {
    const data = safeParseJSON(msg.toString());
    if (!data) return;
    // media data expected to be base64 pcm16 from client (as in your widget code)
    if (data.type === 'input_audio') {
      // forward to OpenAI realtime append
      try {
        if (wsOpenAI && wsOpenAI.readyState === wsOpenAI.OPEN) {
          wsOpenAI.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: data.data
          }));
        }
      } catch (err) {
        console.warn("Failed to forward audio chunk to OpenAI:", err);
      }
    } else if (data.type === 'commit') {
      try {
        if (wsOpenAI && wsOpenAI.readyState === wsOpenAI.OPEN) {
          wsOpenAI.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        }
      } catch (err) {
        console.warn("Failed to send commit to OpenAI:", err);
      }
    } else if (data.type === 'clear') {
      try {
        if (wsOpenAI && wsOpenAI.readyState === wsOpenAI.OPEN) {
          wsOpenAI.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
        }
      } catch (err) {
        console.warn("Failed to send clear to OpenAI:", err);
      }
    } else if (data.type === 'text_message') {
      // optional: send user text to OpenAI as a user message
      try {
        if (wsOpenAI && wsOpenAI.readyState === wsOpenAI.OPEN) {
          wsOpenAI.send(JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: data.text }] }
          }));
          wsOpenAI.send(JSON.stringify({ type: 'response.create' }));
        }
      } catch (err) {
        console.warn("Failed to send text message to OpenAI:", err);
      }
    }
  });

  wsClient.on('close', () => {
    // client disconnected — clean up OpenAI ws
    try {
      if (wsOpenAI && wsOpenAI.readyState === wsOpenAI.OPEN) wsOpenAI.close();
    } catch (e) {}
    if (keepAliveInterval) clearInterval(keepAliveInterval);
  });

  wsClient.on('error', (err) => {
    console.warn('Client WS error:', err);
    try { if (wsOpenAI && wsOpenAI.readyState === wsOpenAI.OPEN) wsOpenAI.close(); } catch(e){}
    if (keepAliveInterval) clearInterval(keepAliveInterval);
  });
});

// ---------------- HTTP endpoints ----------------
app.post("/api/chat/init", async (req, res) => {
  try {
    const session = mkSession();
    const greeting = `Thanks for calling ${BRAND}. How may we help you today? Is it sales, support or accounts?`;
    session.messages.push({ role: "assistant", content: greeting });
    sessions.set(session.id, session);
    const ttsBuf = await makeTTS(greeting);
    const audioBase64 = ttsBuf ? ttsBuf.toString("base64") : null;
    return res.json({ sessionId: session.id, text: greeting, audioBase64 });
  } catch (err) {
    console.error("chat init err", err);
    return res.status(500).json({ error: err?.message || "server error" });
  }
});

app.post("/api/voice", upload.single("audio"), async (req, res) => {
  const incomingSessionId = (req.body && req.body.sessionId) || req.query.sessionId || req.headers["x-session-id"] || null;
  if (!req.file) return res.status(400).json({ error: "Missing audio file (multipart field 'audio')" });

  const uploadedPath = path.resolve(req.file.path);
  let convertedPath = null;

  try {
    const session = (incomingSessionId && sessions.has(incomingSessionId)) ? sessions.get(incomingSessionId) : mkSession(incomingSessionId);

    const consentField = (req.body && req.body.consent);
    if (consentField === "true" || consentField === true) session.consent = true;

    // determine if already WAV
    const origName = (req.file.originalname || "").toLowerCase();
    const mimetype = (req.file.mimetype || "").toLowerCase();
    const looksLikeWav = origName.endsWith(".wav") || mimetype === "audio/wav" || mimetype === "audio/wave" || mimetype === "audio/x-wav";

    if (looksLikeWav) convertedPath = uploadedPath;
    else convertedPath = await convertToWav(uploadedPath);

    // call OpenAI transcription
    const transcriptionResp = await openai.audio.transcriptions.create({
      file: fs.createReadStream(convertedPath),
      model: "gpt-4o-mini-transcribe"
    });

    const userTextRaw = normalizeText(transcriptionResp?.text || "");
    if (!userTextRaw) {
      const prompt = "Sorry, I didn't catch that — could you please repeat briefly?";
      const ttsBuf = await makeTTS(prompt);
      session.lastSeen = new Date().toISOString();
      sessions.set(session.id, session);
      return res.json({ sessionId: session.id, text: prompt, audioBase64: ttsBuf ? ttsBuf.toString("base64") : null });
    }

    session.messages.push({ role: "user", content: userTextRaw });

    // quick consent detection
    const low = userTextRaw.toLowerCase();
    const consentWords = ["yes","yeah","yep","sure","ok","okay","of course","i consent","record","نعم","ہاں","si","oui"];
    if (consentWords.some(w => low.includes(w))) {
      session.consent = true;
      session.messages.push({ role: "assistant", content: "User gave consent to record." });
    }

    // function extraction via chat.completions
    let extractionResult = null;
    try {
      const funcResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: session.messages,
        functions: [extractFunction],
        function_call: "auto",
        temperature: 0.0,
        max_tokens: 300
      });
      const choice = funcResp.choices?.[0];
      const msg = choice?.message;
      if (msg) {
        if (msg.function_call && msg.function_call.arguments) {
          const parsed = safeParseJSON(msg.function_call.arguments);
          if (parsed) {
            extractionResult = applyExtractionToSession(session, parsed);
            session.messages.push(msg);
          }
        } else if (msg.content) {
          session.messages.push({ role: "assistant", content: msg.content });
          const assistantText = msg.content;
          const ttsBuf = await makeTTS(assistantText);
          sessions.set(session.id, session);
          return res.json({ sessionId: session.id, text: assistantText, audioBase64: ttsBuf ? ttsBuf.toString("base64") : null });
        }
      }
    } catch (err) {
      console.warn("Function extraction failed:", err?.message || err);
    }

    // Compose final reply using collected fields
    const collectedSummary = `CollectedFields: ${JSON.stringify(session.collected || {})}. Consent: ${session.consent === true}.`;
    const followupSystem = `You are a concise assistant. Use collected fields and do not re-ask already present info. If missing, ask one short question. Reply in English.`;
    const finalMessages = [
      { role: "system", content: followupSystem },
      ...session.messages,
      { role: "system", content: collectedSummary }
    ];

    const finalResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: finalMessages,
      temperature: 0.0,
      max_tokens: 350
    });

    const assistantText = finalResp.choices?.[0]?.message?.content?.trim() ||
                          `Thanks — I have your details. A human agent can contact you to continue.`;

    session.messages.push({ role: "assistant", content: assistantText });
    const ttsBuf = await makeTTS(assistantText);
    session.lastSeen = new Date().toISOString();
    sessions.set(session.id, session);

    return res.json({ sessionId: session.id, text: assistantText, audioBase64: ttsBuf ? ttsBuf.toString("base64") : null });
  } catch (err) {
    console.error("server error:", err);
    return res.status(500).json({ error: err?.message || "server error" });
  } finally {
    // cleanup
    try { if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath); } catch(_) {}
    try { if (convertedPath && convertedPath !== uploadedPath && fs.existsSync(convertedPath)) fs.unlinkSync(convertedPath); } catch(_) {}
  }
});

// ---------------- chat message endpoint ----------------
app.post("/api/chat/message", async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!message) return res.status(400).json({ error: "Missing message" });
    const session = (sessionId && sessions.has(sessionId)) ? sessions.get(sessionId) : mkSession(sessionId);
    session.messages.push({ role: "user", content: message });

    const low = message.toLowerCase();
    const consentWords = ["yes","agree","okay","ok","i consent","record"];
    if (consentWords.some(w => low.includes(w))) {
      session.consent = true;
      session.messages.push({ role: "assistant", content: "User gave consent to record." });
    }

    let extractionResult = null;
    try {
      const funcResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: session.messages,
        functions: [extractFunction],
        function_call: "auto",
        temperature: 0.0,
        max_tokens: 300
      });
      const choice = funcResp.choices?.[0];
      const msg = choice?.message;
      if (msg) {
        if (msg.function_call && msg.function_call.arguments) {
          const parsed = safeParseJSON(msg.function_call.arguments);
          if (parsed) {
            extractionResult = applyExtractionToSession(session, parsed);
            session.messages.push(msg);
          }
        } else if (msg.content) {
          session.messages.push({ role: "assistant", content: msg.content });
          sessions.set(session.id, session);
          return res.json({ sessionId: session.id, text: msg.content, collected: session.collected });
        }
      }
    } catch (err) {
      console.warn("Function extraction failed:", err?.message || err);
    }

    const collectedSummary = `CollectedFields: ${JSON.stringify(session.collected || {})}. Consent: ${session.consent === true}.`;
    const followupSystem = `You are a concise assistant for ISP CRM. Use collected fields and only ask missing info in one short question.`;
    const finalMessages = [
      { role: "system", content: followupSystem },
      ...session.messages,
      { role: "system", content: collectedSummary }
    ];
    const finalResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: finalMessages,
      temperature: 0.0,
      max_tokens: 350
    });
    const assistantText = finalResp.choices?.[0]?.message?.content?.trim() ||
                          "Thanks — I have your details. A human agent can contact you to continue.";
    session.messages.push({ role: "assistant", content: assistantText });
    session.lastSeen = new Date().toISOString();
    sessions.set(session.id, session);

    // optionally create ticket if criteria met (stubbed)
    if (session.collected.intent === "support" && session.collected.issueSummary && session.consent) {
      // Example: const ticket = await Splynx.createTicket({...}); session.collected.ticketId = ticket.id;
    }

    return res.json({ sessionId: session.id, text: assistantText, collected: session.collected });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "server error" });
  }
});

// cleanup stale sessions every hour (12h timeout)
setInterval(() => {
  const cutoff = Date.now() - (12 * 60 * 60 * 1000);
  for (const [k, v] of sessions.entries()) {
    if (new Date(v.lastSeen).getTime() < cutoff) sessions.delete(k);
  }
}, 60 * 60 * 1000);

server.listen(PORT, () => console.log(`Agent server listening on http://localhost:${PORT}`));