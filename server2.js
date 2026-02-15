// /**
//  * server.js - WebRTC signaling server (fixed)
//  *
//  * - forwards the browser SDP offer to OpenAI /v1/realtime/calls
//  * - handles JSON or raw SDP responses robustly (the API may return plain SDP text)
//  * - returns { sdp, call } where sdp is the SDP string (or null) and call is the raw body (object or text) for debugging
//  *
//  * Usage:
//  *   - create .env with OPENAI_API_KEY and optionally MODEL
//  *   - npm install
//  *   - npm start
//  *
//  * Security: protect /webrtc in production (auth/rate-limits).
//  */

// import express from "express";
// import fetch from "node-fetch";
// import FormData from "form-data";
// import cors from "cors";
// import dotenv from "dotenv";

// dotenv.config();

// const app = express();
// app.use(cors());
// app.use(express.json());
// app.use(express.static("public"));

// const PORT = process.env.PORT || 3000;
// const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// const DEFAULT_MODEL = process.env.MODEL || "gpt-4o-realtime-preview";

// if (!OPENAI_API_KEY) {
//   console.error("Please set OPENAI_API_KEY in .env");
//   process.exit(1);
// }

// // Your conversational system instructions for realtime session:
// const SYSTEM_PROMPT = `
// You are a friendly, concise mortgage sales voice agent. Speak in English.
// Collect intent (purchase/refinance), property value (USD), desired loan amount (USD), credit score or range, and timeline.
// Ask one focused question at a time and avoid repeating information already provided.
// If sensitive info (SSN) is requested, instruct transfer to a human.
// When fields are present, give a short non-binding monthly estimate (assume 30-year fixed at 6.5%) and offer to connect to an agent.
// Keep replies short and natural for a phone call.
// `;

// /**
//  * POST /webrtc
//  * body: { sdp: "<offer sdp>", model?: "<model>" }
//  * returns: { sdp: "<answer sdp>" | null, call: <raw openai response (json or text)> }
//  */
// app.post("/webrtc", async (req, res) => {
//   try {
//     const { sdp, model } = req.body || {};
//     if (!sdp) return res.status(400).json({ error: "Missing sdp in request body" });

//     const chosenModel = model || DEFAULT_MODEL;

//     const sessionObj = {
//       type: "realtime",
//       model: chosenModel,
//       instructions: SYSTEM_PROMPT,
//       audio: {
//         input: {
//           // OpenAI requires >= 5000 ms for server_vad
//           turn_detection: { type: "server_vad", idle_timeout_ms: 5000 }
//         },
//         output: {
//           voice: "alloy"
//         }
//       }
//     };

//     const form = new FormData();
//     form.append("sdp", sdp);
//     form.append("session", JSON.stringify(sessionObj));

//     const endpoint = `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(chosenModel)}`;

//     const resp = await fetch(endpoint, {
//       method: "POST",
//       headers: {
//         Authorization: `Bearer ${OPENAI_API_KEY}`
//         // NOTE: do not set Content-Type here (form-data sets it)
//       },
//       body: form
//     });

//     // Try to detect Content-Type and parse accordingly
//     const contentType = (resp.headers.get("content-type") || "").toLowerCase();
//     let callBody = null;
//     let answerSdp = null;

//     if (contentType.includes("application/json") || contentType.includes("application/ld+json")) {
//       // JSON response
//       callBody = await resp.json();
//       // common places the SDP may appear:
//       answerSdp = callBody.sdp || callBody.answer || (callBody.data && callBody.data.sdp) || null;
//     } else {
//       // Non-JSON (likely raw SDP text)
//       const text = await resp.text();
//       callBody = text;
//       // SDP usually begins with "v=0"
//       if (typeof text === "string" && text.indexOf("v=0") !== -1) {
//         // Use the whole text as SDP
//         answerSdp = text;
//       } else {
//         // Not SDP and not JSON; return raw text for debugging
//         answerSdp = null;
//       }
//     }

//     // Return the SDP if found, else return raw call body for debugging
//     return res.json({ sdp: answerSdp, call: callBody });
//   } catch (err) {
//     console.error("webrtc error", err);
//     return res.status(500).json({ error: err?.message || String(err) });
//   }
// });

// app.listen(PORT, () => {
//   console.log(`Realtime WebRTC signaling server listening on http://localhost:${PORT}`);
// });

// server2.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import OpenAI from "openai";
import wrtc from "wrtc"; // default import, then destructure
const { RTCPeerConnection } = wrtc;

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegStatic);

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Please set OPENAI_API_KEY in your environment or .env");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ---------------- Session store ----------------
   For production replace with Redis or another durable store.
*/
const sessions = new Map();

/* ---------------- Strong system prompt ----------------
   This tells the model how to behave, to always reply in English,
   to proceed like a conversational voice agent, and to use short turns.
*/
const SYSTEM_PROMPT = `
You are a concise, professional mortgage sales voice agent that speaks in English.
Rules:
- Always reply in English.
- Use the conversation history to avoid asking for information already provided.
- If the user has not given explicit recording consent, ask for it once and wait.
- Collect the following fields across turns when appropriate: intent (purchase/refinance), propertyValue (USD), loanAmount (USD), creditScoreRange, timeline.
- Keep each question short and focused. Ask one question at a time.
- If you need to extract structured data (numbers, intent, credit-related words), you may call the designated extraction function.
- When all required information is collected, provide a short non-binding summary, a brief estimate (state assumptions: e.g., 30-year fixed at 6.5%), and offer to connect to a human loan officer.
- Do not repeatedly re-ask the same question; if a value changed, ask a single confirmation question.
`;

/* ---------------- Function schema for structured extraction ---------------- */
const extractFunction = {
  name: "extract_mortgage_fields",
  description: "Extract fields from a short transcript into JSON: intent (purchase/refinance), propertyValue (USD integer), loanAmount (USD integer), creditScoreRange (string), timeline (string), consent (boolean). Omit fields not present.",
  parameters: {
    type: "object",
    properties: {
      intent: { type: "string", enum: ["purchase", "refinance"], description: "purchase or refinance" },
      propertyValue: { type: "number", description: "Estimated property value in USD" },
      loanAmount: { type: "number", description: "Desired loan amount in USD" },
      creditScoreRange: { type: "string", description: "Short credit score range or descriptor" },
      timeline: { type: "string", description: "Short timeline descriptor" },
      consent: { type: "boolean", description: "true if user said yes to recording" }
    },
    required: []
  }
};

/* ---------------- Utilities ---------------- */
function mkSession(sessionId) {
  const id = sessionId || `s_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const session = {
    id,
    consent: false,
    collected: {},      // stored structured fields
    messages: [ { role: "system", content: SYSTEM_PROMPT } ], // conversation history
    lastSeen: new Date().toISOString(),
  };
  sessions.set(id, session);
  return session;
}

function normalizeText(t) {
  if (!t) return "";
  return t.toString().replace(/\u200B/g, "").replace(/\s+/g," ").trim();
}

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch(e) { return null; }
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

async function streamToBuffer(body) {
  if (!body) return Buffer.from("");
  if (Buffer.isBuffer(body)) return body;
  if (body.arrayBuffer) {
    const ab = await body.arrayBuffer();
    return Buffer.from(ab);
  }
  if (body.pipe) {
    const chunks = [];
    return new Promise((resolve, reject) => {
      body.on("data", (c) => chunks.push(Buffer.from(c)));
      body.on("end", () => resolve(Buffer.concat(chunks)));
      body.on("error", (err) => reject(err));
    });
  }
  return Buffer.from(JSON.stringify(body));
}

/* ---------------- WebRTC helper: process concatenated webm buffer ----------------
   This re-uses your original transcription -> extraction -> assistant -> TTS flow.
*/
async function processWebmChunkAndRespond({ buffer, sessionId, sendResponseOverChannel }) {
  const uploadsDir = path.resolve("uploads");
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  const filename = path.join(uploadsDir, `webrtc_${sessionId}_${Date.now()}.webm`);
  fs.writeFileSync(filename, buffer);

  let convertedPath = null;
  try {
    convertedPath = await convertToWav(filename);

    // transcribe
    const transcriptionResp = await openai.audio.transcriptions.create({
      file: fs.createReadStream(convertedPath),
      model: "gpt-4o-mini-transcribe"
    });

    const userTextRaw = normalizeText(transcriptionResp?.text || "");
    if (!userTextRaw) {
      const prompt = "Sorry, I didn't catch that — could you please repeat briefly?";
      const tts = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "cedar",
        input: prompt,
        format: "mp3"
      });
      const buf = await streamToBuffer(tts);
      sendResponseOverChannel({ text: prompt, audioBase64: buf.toString("base64") });
      return;
    }

    // session
    const session = (sessionId && sessions.has(sessionId)) ? sessions.get(sessionId) : mkSession(sessionId);

    // append user message to history
    session.messages.push({ role: "user", content: userTextRaw });
    session.lastSeen = new Date().toISOString();

    // quick local consent detection
    const low = userTextRaw.toLowerCase();
    const consentWords = ["yes","yeah","yep","sure","ok","okay","of course","نعم","يس","ہاں","ha","si","sí","oui"];
    const locallyGaveConsent = consentWords.some(w => low.includes(w));
    if (locallyGaveConsent) {
      session.consent = true;
      session.collected = session.collected || {};
      session.lastSeen = new Date().toISOString();
      session.messages.push({ role: "assistant", content: "User gave consent to record." });
    }

    // Function extraction call
    let extractionResult = null;
    try {
      const funcResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: session.messages,
        functions: [extractFunction],
        function_call: "auto",
        temperature: 0.0,
        max_tokens: 200
      });

      const choice = funcResp.choices?.[0];
      const msg = choice?.message;
      if (msg) {
        if (msg.function_call && msg.function_call.arguments) {
          const argsRaw = msg.function_call.arguments;
          const parsed = safeParseJSON(argsRaw);
          if (parsed) {
            extractionResult = numbersToInt(parsed);
            for (const [k,v] of Object.entries(extractionResult)) {
              if (k === "consent" && v === true) session.consent = true;
              else if (v !== undefined && v !== null) session.collected[k] = v;
            }
            session.messages.push(msg);
          }
        } else if (msg.content) {
          session.messages.push({ role: "assistant", content: msg.content });
          const assistantText = msg.content;
          const tts = await openai.audio.speech.create({
            model: "gpt-4o-mini-tts",
            voice: "cedar",
            input: assistantText + " Please speak slightly faster.",
            format: "mp3"
          });
          const ttsBuf = await streamToBuffer(tts);
          sessions.set(session.id, session);
          sendResponseOverChannel({ text: assistantText, audioBase64: ttsBuf.toString("base64") });
          return;
        }
      }
    } catch (err) {
      console.warn("Function extraction call failed (webrtc helper): ", err?.message || err);
    }

    // Ask model for assistant reply using collected fields summary
    const collectedSummary = `CollectedFields: ${JSON.stringify(session.collected || {})}. Consent: ${session.consent === true}.`;
    const followupSystem = `You are a concise mortgage assistant. Use the collected fields from the session and do not ask again for any information already present. If something is missing, ask a single short question asking only the missing piece. Reply in English and keep it short.`;

    const finalMessages = [
      { role: "system", content: followupSystem },
      ...session.messages,
      { role: "system", content: collectedSummary }
    ];

    const finalResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: finalMessages,
      temperature: 0.0,
      max_tokens: 220
    });

    const assistantText = finalResp.choices?.[0]?.message?.content?.trim() ||
                          "Thanks — I have your details. A loan officer can contact you to continue.";

    session.messages.push({ role: "assistant", content: assistantText });

    const tts = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "cedar",
      input: assistantText + " Please speak slightly faster than usual.",
      format: "mp3"
    });
    const ttsBuf = await streamToBuffer(tts);

    session.lastSeen = new Date().toISOString();
    sessions.set(session.id, session);

    sendResponseOverChannel({ text: assistantText, audioBase64: ttsBuf.toString("base64") });

  } catch (err) {
    console.error("webrtc chunk processing error:", err);
    try { sendResponseOverChannel({ text: "Server error processing audio", audioBase64: null }); } catch(_) {}
  } finally {
    try { if (fs.existsSync(filename)) fs.unlinkSync(filename); } catch(_) {}
    try { if (convertedPath && fs.existsSync(convertedPath)) fs.unlinkSync(convertedPath); } catch(_) {}
  }
}

/* ---------------- Main endpoint (unchanged) ----------------
   I re-inserted your original /api/voice handler here exactly as you provided it.
*/
app.post("/api/voice", upload.single("audio"), async (req, res) => {
  const incomingSessionId = (req.body && req.body.sessionId) || req.query.sessionId || req.headers["x-session-id"] || null;
  if (!req.file) return res.status(400).json({ error: "Missing audio file (multipart field 'audio')" });

  const uploadedPath = path.resolve(req.file.path);
  let convertedPath = null;

  try {
    // session
    const session = (incomingSessionId && sessions.has(incomingSessionId)) ? sessions.get(incomingSessionId) : mkSession(incomingSessionId);

    console.log("Received file:", req.file.originalname, req.file.mimetype, "sessionId:", session.id);

    // convert and transcribe
    convertedPath = await convertToWav(uploadedPath);
    console.log("Converted to WAV:", convertedPath);

    const transcriptionResp = await openai.audio.transcriptions.create({
      file: fs.createReadStream(convertedPath),
      model: "gpt-4o-mini-transcribe"
    });

    const userTextRaw = normalizeText(transcriptionResp?.text || "");
    console.log("Transcription:", userTextRaw);

    // if nothing transcribed: short deterministic ask
    if (!userTextRaw) {
      const prompt = "Sorry, I didn't catch that — could you please repeat briefly?";
      const tts = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "cedar",
        input: prompt,
        format: "mp3"
      });
      const buf = await streamToBuffer(tts);
      session.lastSeen = new Date().toISOString();
      sessions.set(session.id, session);
      return res.json({ sessionId: session.id, text: prompt, audioBase64: buf.toString("base64") });
    }

    // append user message to history
    session.messages.push({ role: "user", content: userTextRaw });
    session.lastSeen = new Date().toISOString();

    // quick local consent detection: common yes words (so agent doesn't loop)
    const low = userTextRaw.toLowerCase();
    const consentWords = ["yes","yeah","yep","sure","ok","okay","of course","نعم","يس","ہاں","ha","si","sí","oui"];
    const locallyGaveConsent = consentWords.some(w => low.includes(w));
    if (locallyGaveConsent) {
      session.consent = true;
      session.collected = session.collected || {};
      session.lastSeen = new Date().toISOString();
      // add a short assistant ack in history to keep context consistent
      session.messages.push({ role: "assistant", content: "User gave consent to record." });
    }

    // Call the model with function call auto to let it decide to extract fields if helpful
    let extractionResult = null;
    try {
      const funcResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: session.messages,
        functions: [extractFunction],
        function_call: "auto",
        temperature: 0.0,
        max_tokens: 200
      });

      const choice = funcResp.choices?.[0];
      const msg = choice?.message;
      if (msg) {
        // if model returned a function_call, parse args and store
        if (msg.function_call && msg.function_call.arguments) {
          const argsRaw = msg.function_call.arguments;
          const parsed = safeParseJSON(argsRaw);
          if (parsed) {
            extractionResult = numbersToInt(parsed);
            // update session fields and consent if provided
            for (const [k,v] of Object.entries(extractionResult)) {
              if (k === "consent" && v === true) session.consent = true;
              else if (v !== undefined && v !== null) session.collected[k] = v;
            }
            // store the function_call message in history (so model sees it)
            session.messages.push(msg);
          }
        } else if (msg.content) {
          // No function_call but assistant produced content: use it as assistant reply
          // We'll use that as assistantText below
          session.messages.push({ role: "assistant", content: msg.content });
          const assistantText = msg.content;
          // TTS and return
          const tts = await openai.audio.speech.create({
            model: "gpt-4o-mini-tts",
            voice: "cedar",
            input: assistantText + " Please speak slightly faster.",
            format: "mp3"
          });
          const ttsBuf = await streamToBuffer(tts);
          sessions.set(session.id, session);
          return res.json({ sessionId: session.id, text: assistantText, audioBase64: ttsBuf.toString("base64") });
        }
      }
    } catch (err) {
      // function calling failed (older SDKs or API mismatch). We log and fall back to single model pass below.
      console.warn("Function extraction call failed: ", err?.message || err);
    }

    // After extraction (if any), ask the model for an assistant reply using updated session.messages plus a short system instruction:
    // We instruct the model to not re-ask for already collected fields.
    const collectedSummary = `CollectedFields: ${JSON.stringify(session.collected || {})}. Consent: ${session.consent === true}.`;
    const followupSystem = `You are a concise mortgage assistant. Use the collected fields from the session and do not ask again for any information already present. If something is missing, ask a single short question asking only the missing piece. Reply in English and keep it short.`;

    // Build messages for final response: include session.messages and an extra user-system hint
    const finalMessages = [
      { role: "system", content: followupSystem },
      ...session.messages,
      { role: "system", content: collectedSummary }
    ];

    // Ask model to produce final assistant reply (text)
    const finalResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: finalMessages,
      temperature: 0.0,
      max_tokens: 220
    });

    const assistantText = finalResp.choices?.[0]?.message?.content?.trim() ||
                          "Thanks — I have your details. A loan officer can contact you to continue.";

    // store assistant reply in history
    session.messages.push({ role: "assistant", content: assistantText });

    // TTS the assistant reply (ask slightly faster)
    const tts = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "cedar",
      input: assistantText + " Please speak slightly faster than usual.",
      format: "mp3"
    });
    const ttsBuf = await streamToBuffer(tts);

    // save session and return
    session.lastSeen = new Date().toISOString();
    sessions.set(session.id, session);

    return res.json({ sessionId: session.id, text: assistantText, audioBase64: ttsBuf.toString("base64") });

  } catch (err) {
    console.error("server error:", err);
    return res.status(500).json({ error: err?.message || "server error" });
  } finally {
    // cleanup files
    try { if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath); } catch(_) {}
    try { if (convertedPath && fs.existsSync(convertedPath)) fs.unlinkSync(convertedPath); } catch(_) {}
  }
});

/* ---------------- WebRTC offer endpoint (new) ----------------
   Client will POST { sdp: <offer sdp>, sessionId: <optional> } and receives { answer: <sdp>, sessionId }.
   The server creates an RTCPeerConnection, receives a datachannel, buffers webm fragments
   per-segment, and calls processWebmChunkAndRespond when a segment ends (or inactivity timeout).
*/
app.post("/webrtc/offer", async (req, res) => {
  try {
    const { sdp, sessionId: incomingSessionId } = req.body;
    if (!sdp) return res.status(400).json({ error: "Missing SDP offer in request body (sdp)" });

    const pc = new RTCPeerConnection({ iceServers: [] });

    const sid = incomingSessionId || `s_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    sessions.set(sid, sessions.get(sid) || mkSession(sid)); // ensure session exists

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed") {
        try { pc.close(); } catch(_) {}
      }
    };

    pc.ondatachannel = (ev) => {
      const dc = ev.channel;
      dc.binaryType = "arraybuffer";
      console.log("Server: datachannel received:", dc.label);

      // per-session ephemeral storage for chunks + timer
      const s = sessions.get(sid) || mkSession(sid);
      if (!s._webrtcChunks) s._webrtcChunks = [];
      if (s._webrtcTimer) { clearTimeout(s._webrtcTimer); s._webrtcTimer = null; }

      dc.onopen = () => {
        console.log("DataChannel open");
      };

      dc.onclose = () => {
        console.log("DataChannel closed");
      };

      dc.onmessage = async (m) => {
        try {
          // Text message => control
          if (typeof m.data === "string") {
            let parsed = null;
            try { parsed = JSON.parse(m.data); } catch (e) { parsed = null; }

            if (parsed && parsed.type === "session") {
              if (parsed.sessionId) {
                const sId = parsed.sessionId;
                if (!sessions.has(sId)) mkSession(sId);
              }
              return;
            }

            if (parsed && parsed.type === "segment_start") {
              const sess = sessions.get(sid) || mkSession(sid);
              sess._webrtcChunks = [];
              if (sess._webrtcTimer) { clearTimeout(sess._webrtcTimer); sess._webrtcTimer = null; }
              return;
            }

            if (parsed && parsed.type === "segment_end") {
              const sess = sessions.get(sid) || mkSession(sid);
              const chunks = (sess._webrtcChunks && sess._webrtcChunks.length) ? sess._webrtcChunks : [];
              if (sess._webrtcTimer) { clearTimeout(sess._webrtcTimer); sess._webrtcTimer = null; }
              sess._webrtcChunks = [];
              if (chunks.length === 0) return;
              const fullBuf = Buffer.concat(chunks);
              const sendResponseOverChannel = ({ text, audioBase64 }) => {
                const payload = { text: text || "", audioBase64: audioBase64 || null };
                try { dc.send(JSON.stringify(payload)); } catch (e) { console.warn("Failed to send over datachannel", e); }
              };
              await processWebmChunkAndRespond({ buffer: fullBuf, sessionId: sid, sendResponseOverChannel });
              return;
            }

            return;
          }

          // Binary -> push to buffer and reset inactivity timer
          const arr = new Uint8Array(m.data);
          const buf = Buffer.from(arr);
          const sess = sessions.get(sid) || mkSession(sid);
          if (!sess._webrtcChunks) sess._webrtcChunks = [];
          sess._webrtcChunks.push(buf);

          if (sess._webrtcTimer) clearTimeout(sess._webrtcTimer);
          sess._webrtcTimer = setTimeout(async () => {
            try {
              const chunksToFlush = (sess._webrtcChunks && sess._webrtcChunks.length) ? sess._webrtcChunks : [];
              sess._webrtcChunks = [];
              sess._webrtcTimer = null;
              if (chunksToFlush.length === 0) return;
              const fullBuf = Buffer.concat(chunksToFlush);
              const sendResponseOverChannel = ({ text, audioBase64 }) => {
                const payload = { text: text || "", audioBase64: audioBase64 || null };
                try { dc.send(JSON.stringify(payload)); } catch (e) { console.warn("Failed to send over datachannel", e); }
              };
              await processWebmChunkAndRespond({ buffer: fullBuf, sessionId: sid, sendResponseOverChannel });
            } catch (err) {
              console.error("Error flushing webrtc buffered chunks:", err);
              try { dc.send(JSON.stringify({ text: "Server error processing audio", audioBase64: null })); } catch(_) {}
            }
          }, 800); // flush after 800ms inactivity

        } catch (err) {
          console.error("datachannel message processing error:", err);
          try { dc.send(JSON.stringify({ text: "Server error processing chunk", audioBase64: null })); } catch(_) {}
        }
      };
    };

    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    res.json({ answer: pc.localDescription.sdp, sessionId: sid });

    // keep reference to pc for cleanup
    const meta = sessions.get(sid) || {};
    meta._pc = pc;
    sessions.set(sid, meta);

    setTimeout(() => {
      try { pc.close(); } catch(_) {}
      const s = sessions.get(sid);
      if (s && s._pc) delete s._pc;
    }, 10 * 60 * 1000);

  } catch (err) {
    console.error("webrtc offer error:", err);
    return res.status(500).json({ error: err?.message || "webrtc offer failed" });
  }
});

/* cleanup stale sessions */
setInterval(() => {
  const cutoff = Date.now() - (12 * 60 * 60 * 1000);
  for (const [k, v] of sessions.entries()) {
    if (new Date(v.lastSeen).getTime() < cutoff) sessions.delete(k);
    if (v && v._pc && typeof v._pc.close === "function") {
      try { v._pc.close(); } catch(_) {}
    }
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => console.log(`Optimized voice agent listening on http://localhost:${PORT}`));
