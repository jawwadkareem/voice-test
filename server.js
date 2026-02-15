// // server.js
// import express from "express";
// import fetch from "node-fetch";
// import dotenv from "dotenv";
// import cors from "cors";
// import path from "path";
// import { fileURLToPath } from "url";

// dotenv.config();

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const app = express();

// app.use(cors());
// app.use(express.json());

// // serve frontend
// app.use(express.static(path.join(__dirname, "../public")));

// const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// const PORT = process.env.PORT || 3000;
// const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime";
// const SYSTEM_PROMPT =
//   process.env.SYSTEM_PROMPT ||
//   "You are Jess from Omni Mortgage, a friendly mortgage specialist.";

// if (!OPENAI_API_KEY) {
//   console.error("Missing OPENAI_API_KEY in .env");
//   process.exit(1);
// }

// /**
//  * Create ephemeral realtime session
//  */
// app.get("/session", async (req, res) => {
//   try {
//     const r = await fetch(
//       "https://api.openai.com/v1/realtime/client_secrets",
//       {
//         method: "POST",
//         headers: {
//           Authorization: `Bearer ${OPENAI_API_KEY}`,
//           "Content-Type": "application/json"
//         },
//         body: JSON.stringify({
//           session: {
//             type: "realtime",
//             model: REALTIME_MODEL,
//             instructions: SYSTEM_PROMPT,
//             audio: {
//               output: {
//                 voice: "alloy"
//               }
//             }
//           }
//         })
//       }
//     );

//     if (!r.ok) {
//       const errText = await r.text();
//       console.error(errText);
//       return res.status(500).json({ error: errText });
//     }

//     const data = await r.json();

//     let client_secret = data.value;
//     if (typeof client_secret === "object") {
//       client_secret = client_secret.value;
//     }

//     res.json({ client_secret });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: err.message });
//   }
// });

// app.get("/health", (req, res) => {
//   res.json({ ok: true });
// });

// app.get("/", (req, res) => {
//   res.sendFile(path.join(__dirname, "../public/voice-agent.html"));
// });

// app.listen(PORT, () => {
//   console.log(`Server running → http://localhost:${PORT}`);
// });

/**
 * Simple Express server:
 *  - POST /api/voice  : accepts multipart/form-data `audio` file (wav/mpeg)
 *  - Uses OpenAI Audio Transcription -> Chat Completion -> Audio TTS
 *  - Returns { text, audioBase64 } where audioBase64 is an mp3.
 *
 * NOTE:
 *  - Set environment variable OPENAI_API_KEY
 *  - This example uses the official OpenAI JS client shape (OpenAI constructor).
 *    Adjust call signatures if your SDK version differs.
 */
/**
 * server.js
 * - Maintains full conversation history per session (system + messages).
 * - Uses Chat Completions with functions and function_call: "auto" so the model decides to extract fields.
 * - After extraction, updates session.collected and then asks the model to produce a short English reply.
 * - Converts uploaded webm to wav, transcribes, TTS the assistant reply to MP3 base64.
 *
 * Requirements: .env with OPENAI_API_KEY, ffmpeg-static, fluent-ffmpeg, openai, express, multer, cors
 */

import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import OpenAI from "openai";

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
app.use(express.json());
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

/* ---------------- Main endpoint ----------------
   Flow:
   1) transcribe audio
   2) append user message to session.messages
   3) call chat.completions with functions + function_call: "auto"
   4) if model returns function_call -> parse JSON args, update session.collected and session.consent
   5) append extraction/followup to history and call model again to produce assistantText (no function)
   6) tts the assistantText and return audio + text + sessionId
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

/* cleanup stale sessions */
setInterval(() => {
  const cutoff = Date.now() - (12 * 60 * 60 * 1000);
  for (const [k, v] of sessions.entries()) {
    if (new Date(v.lastSeen).getTime() < cutoff) sessions.delete(k);
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => console.log(`Optimized voice agent listening on http://localhost:${PORT}`));
