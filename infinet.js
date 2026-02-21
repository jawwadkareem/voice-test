// // server.js
// import express from "express";
// import multer from "multer";
// import fs from "fs";
// import path from "path";
// import cors from "cors";
// import dotenv from "dotenv";
// import ffmpeg from "fluent-ffmpeg";
// import ffmpegStatic from "ffmpeg-static";
// import OpenAI from "openai";
// import fetch from "node-fetch"; // node 18+ may have fetch built-in; keep for clarity

// dotenv.config();
// ffmpeg.setFfmpegPath(ffmpegStatic);

// const PORT = process.env.PORT || 3000;
// const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// if (!OPENAI_API_KEY) {
//   console.error("Please set OPENAI_API_KEY in your environment or .env");
//   process.exit(1);
// }

// const app = express();
// app.use(cors());
// app.use(express.json());
// app.use(express.static("public"));

// const upload = multer({ dest: "uploads/" });
// const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// /* ---------------- In-memory sessions (replace with Redis for production) ---------------- */
// const sessions = new Map();

// /* ---------------- System prompt (agent behavior) ---------------- */
// const SYSTEM_PROMPT = `
// You are a concise, professional voice/chat assistant for an ISP CRM.
// Handle four call types / chat intents: support, sales, general, account.
// Rules:
// - Always reply in English.
// - Keep replies short and focused; ask one thing at a time.
// - Respect consent: if user hasn't consented to recording/transcript, request consent once and wait.
// - Collect structured fields when appropriate and do not re-ask for already collected fields.
// - If sufficient info for an action (create ticket or lead), return an explicit action result (via the extraction function) or indicate next step.
// - When handing over to a human, set a "handover" flag in the response.
// `;

// /* ---------------- Function schema for extraction (function calling) ---------------- */
// const extractFunction = {
//   name: "extract_call_fields",
//   description:
//     "Extract fields from user message: intent (support/sales/general/account), issueSummary, customerName, customerPhone, email, priority, consent (boolean), callbackRequest (boolean), timeline, leadInterest. Omit fields not present.",
//   parameters: {
//     type: "object",
//     properties: {
//       intent: { type: "string", enum: ["support", "sales", "general", "account"] },
//       issueSummary: { type: "string" },
//       customerName: { type: "string" },
//       customerPhone: { type: "string" },
//       email: { type: "string" },
//       priority: { type: "string", enum: ["low","medium","high","urgent"] },
//       consent: { type: "boolean" },
//       callbackRequest: { type: "boolean" },
//       timeline: { type: "string" },
//       leadInterest: { type: "string" }
//     },
//     required: []
//   }
// };

// /* ---------------- Utilities ---------------- */
// function mkSession(sessionId) {
//   const id = sessionId || `s_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
//   const session = {
//     id,
//     consent: false,
//     collected: {},
//     messages: [{ role: "system", content: SYSTEM_PROMPT }],
//     lastSeen: new Date().toISOString(),
//   };
//   sessions.set(id, session);
//   return session;
// }

// function normalizeText(t) {
//   if (!t) return "";
//   return t.toString().replace(/\u200B/g, "").replace(/\s+/g, " ").trim();
// }

// function safeParseJSON(s) {
//   try { return JSON.parse(s); } catch(e) { return null; }
// }

// function numbersToInt(obj) {
//   const out = {};
//   for (const k of Object.keys(obj || {})) {
//     const v = obj[k];
//     if (typeof v === "number") out[k] = Math.round(v);
//     else out[k] = v;
//   }
//   return out;
// }

// async function convertToWav(inputPath) {
//   const out = inputPath + ".converted.wav";
//   return new Promise((resolve, reject) => {
//     ffmpeg(inputPath)
//       .outputOptions(["-ar 16000", "-ac 1", "-vn"])
//       .toFormat("wav")
//       .on("end", () => resolve(out))
//       .on("error", (err) => reject(err))
//       .save(out);
//   });
// }

// async function streamToBuffer(body) {
//   if (!body) return Buffer.from("");
//   if (Buffer.isBuffer(body)) return body;
//   if (body.arrayBuffer) {
//     const ab = await body.arrayBuffer();
//     return Buffer.from(ab);
//   }
//   if (body.pipe) {
//     const chunks = [];
//     return new Promise((resolve, reject) => {
//       body.on("data", (c) => chunks.push(Buffer.from(c)));
//       body.on("end", () => resolve(Buffer.concat(chunks)));
//       body.on("error", (err) => reject(err));
//     });
//   }
//   return Buffer.from(JSON.stringify(body));
// }

// /* ---------------- Splynx / CRM helper stubs (placeholders) ----------------
//    Implement these to actually call Splynx API.
//    e.g. splynxBase = process.env.SPLYNX_BASE; splynxKey = process.env.SPLYNX_KEY
// */
// const Splynx = {
//   async findCustomerByPhone(phone) {
//     // placeholder: implement /customers/search?phone={phone}
//     // return null or an object { id, name, phone, email }
//     return null;
//   },
//   async createCustomer(payload) {
//     // placeholder: POST /admin/customers/customer
//     // return created customer object
//     return { id: "cust_stub_id", ...payload };
//   },
//   async createTicket(payload) {
//     // placeholder: POST /support/ticket
//     // return created ticket id/object
//     return { id: "ticket_stub_id", ...payload };
//   },
//   async appendTicketMessage(ticketId, message) {
//     // placeholder: POST /tickets/{id}/messages
//     return true;
//   }
// };

// /* ---------------- Core: handle function-call extraction result ---------------- */
// function applyExtractionToSession(session, parsed) {
//   const extractionResult = numbersToInt(parsed || {});
//   for (const [k,v] of Object.entries(extractionResult)) {
//     if (k === "consent" && v === true) session.consent = true;
//     else if (v !== undefined && v !== null) session.collected[k] = v;
//   }
//   session.lastSeen = new Date().toISOString();
//   sessions.set(session.id, session);
//   return extractionResult;
// }

// /* ---------------- Voice endpoint ----------------
//    Flow: upload audio -> convert -> transcribe -> function-call extraction -> final assistant reply -> tts mp3 base64
// */
// app.post("/api/voice", upload.single("audio"), async (req, res) => {
//   const incomingSessionId = (req.body && req.body.sessionId) || req.query.sessionId || req.headers["x-session-id"] || null;
//   if (!req.file) return res.status(400).json({ error: "Missing audio file (multipart field 'audio')" });

//   const uploadedPath = path.resolve(req.file.path);
//   let convertedPath = null;

//   try {
//     // session
//     const session = (incomingSessionId && sessions.has(incomingSessionId)) ? sessions.get(incomingSessionId) : mkSession(incomingSessionId);

//     // convert and transcribe
//     convertedPath = await convertToWav(uploadedPath);

//     const transcriptionResp = await openai.audio.transcriptions.create({
//       file: fs.createReadStream(convertedPath),
//       model: "gpt-4o-mini-transcribe"
//     });

//     const userTextRaw = normalizeText(transcriptionResp?.text || "");
//     if (!userTextRaw) {
//       const prompt = "Sorry, I didn't catch that — could you please repeat briefly?";
//       const tts = await openai.audio.speech.create({
//         model: "gpt-4o-mini-tts",
//         voice: "cedar",
//         input: prompt,
//         format: "mp3"
//       });
//       const buf = await streamToBuffer(tts);
//       session.lastSeen = new Date().toISOString();
//       sessions.set(session.id, session);
//       return res.json({ sessionId: session.id, text: prompt, audioBase64: buf.toString("base64") });
//     }

//     session.messages.push({ role: "user", content: userTextRaw });

//     // local quick consent detection
//     const low = userTextRaw.toLowerCase();
//     const consentWords = ["yes","yeah","yep","sure","ok","okay","of course","نعم","ہاں","si","oui"];
//     if (consentWords.some(w => low.includes(w))) {
//       session.consent = true;
//       session.collected = session.collected || {};
//       session.messages.push({ role: "assistant", content: "User gave consent to record." });
//     }

//     // function-call extraction attempt
//     let extractionResult = null;
//     try {
//       const funcResp = await openai.chat.completions.create({
//         model: "gpt-4o-mini",
//         messages: session.messages,
//         functions: [extractFunction],
//         function_call: "auto",
//         temperature: 0.0,
//         max_tokens: 200
//       });

//       const choice = funcResp.choices?.[0];
//       const msg = choice?.message;
//       if (msg) {
//         if (msg.function_call && msg.function_call.arguments) {
//           const argsRaw = msg.function_call.arguments;
//           const parsed = safeParseJSON(argsRaw);
//           if (parsed) {
//             extractionResult = applyExtractionToSession(session, parsed);
//             // record function_call message for context
//             session.messages.push(msg);
//           }
//         } else if (msg.content) {
//           session.messages.push({ role: "assistant", content: msg.content });
//           const assistantText = msg.content;
//           const tts = await openai.audio.speech.create({
//             model: "gpt-4o-mini-tts",
//             voice: "cedar",
//             input: assistantText,
//             format: "mp3"
//           });
//           const ttsBuf = await streamToBuffer(tts);
//           sessions.set(session.id, session);
//           return res.json({ sessionId: session.id, text: assistantText, audioBase64: ttsBuf.toString("base64") });
//         }
//       }
//     } catch (err) {
//       console.warn("Function extraction failed:", err?.message || err);
//     }

//     // produce assistant final reply using collected fields
//     const collectedSummary = `CollectedFields: ${JSON.stringify(session.collected || {})}. Consent: ${session.consent === true}.`;
//     const followupSystem = `You are a concise assistant. Use collected fields and do not re-ask already present info. If missing, ask one short question. Reply in English.`;

//     const finalMessages = [
//       { role: "system", content: followupSystem },
//       ...session.messages,
//       { role: "system", content: collectedSummary }
//     ];

//     const finalResp = await openai.chat.completions.create({
//       model: "gpt-4o-mini",
//       messages: finalMessages,
//       temperature: 0.0,
//       max_tokens: 220
//     });

//     const assistantText = finalResp.choices?.[0]?.message?.content?.trim() ||
//                           "Thanks — I have your details. A human agent can contact you to continue.";

//     session.messages.push({ role: "assistant", content: assistantText });

//     const tts = await openai.audio.speech.create({
//       model: "gpt-4o-mini-tts",
//       voice: "cedar",
//       input: assistantText ,
//       format: "mp3"
//     });
//     const ttsBuf = await streamToBuffer(tts);

//     session.lastSeen = new Date().toISOString();
//     sessions.set(session.id, session);

//     return res.json({ sessionId: session.id, text: assistantText, audioBase64: ttsBuf.toString("base64") });

//   } catch (err) {
//     console.error("server error:", err);
//     return res.status(500).json({ error: err?.message || "server error" });
//   } finally {
//     try { if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath); } catch(_) {}
//     try { if (convertedPath && fs.existsSync(convertedPath)) fs.unlinkSync(convertedPath); } catch(_) {}
//   }
// });

// /* ---------------- Chat endpoints (for widget) ---------------- */
// app.post("/api/chat/init", (req, res) => {
//   const session = mkSession();
//   return res.json({ sessionId: session.id });
// });

// app.post("/api/chat/message", async (req, res) => {
//   try {
//     const { sessionId, message, channel = "web" } = req.body;
//     if (!message) return res.status(400).json({ error: "Missing message" });

//     const session = (sessionId && sessions.has(sessionId)) ? sessions.get(sessionId) : mkSession(sessionId);
//     session.messages.push({ role: "user", content: message });

//     // quick consent detect
//     const low = message.toLowerCase();
//     const consentWords = ["yes","agree","okay","ok","i consent","record"];
//     if (consentWords.some(w => low.includes(w))) {
//       session.consent = true;
//       session.messages.push({ role: "assistant", content: "User gave consent to record." });
//     }

//     // function extraction pass
//     let extractionResult = null;
//     try {
//       const funcResp = await openai.chat.completions.create({
//         model: "gpt-4o-mini",
//         messages: session.messages,
//         functions: [extractFunction],
//         function_call: "auto",
//         temperature: 0.0,
//         max_tokens: 200
//       });
//       const choice = funcResp.choices?.[0];
//       const msg = choice?.message;
//       if (msg) {
//         if (msg.function_call && msg.function_call.arguments) {
//           const parsed = safeParseJSON(msg.function_call.arguments);
//           if (parsed) {
//             extractionResult = applyExtractionToSession(session, parsed);
//             session.messages.push(msg);
//           }
//         } else if (msg.content) {
//           session.messages.push({ role: "assistant", content: msg.content });
//           sessions.set(session.id, session);
//           return res.json({ sessionId: session.id, text: msg.content });
//         }
//       }
//     } catch (err) {
//       console.warn("Function extraction failed:", err?.message || err);
//     }

//     // Build final reply using collected fields
//     const collectedSummary = `CollectedFields: ${JSON.stringify(session.collected || {})}. Consent: ${session.consent === true}.`;
//     const followupSystem = `You are a concise assistant for ISP CRM. Use collected fields and only ask missing info in one short question.`;

//     const finalMessages = [
//       { role: "system", content: followupSystem },
//       ...session.messages,
//       { role: "system", content: collectedSummary }
//     ];

//     const finalResp = await openai.chat.completions.create({
//       model: "gpt-4o-mini",
//       messages: finalMessages,
//       temperature: 0.0,
//       max_tokens: 220
//     });

//     const assistantText = finalResp.choices?.[0]?.message?.content?.trim() ||
//                           "Thanks — I have your details. A human agent can contact you to continue.";
//     session.messages.push({ role: "assistant", content: assistantText });
//     session.lastSeen = new Date().toISOString();
//     sessions.set(session.id, session);

//     // optionally: if enough fields for ticket creation, demonstrate local stub action (not calling Splynx yet)
//     if (session.collected.intent === "support" && session.collected.issueSummary && session.consent) {
//       // In production: call Splynx.createTicket(...) and append ticket id to session.collected
//       // const ticket = await Splynx.createTicket({...});
//       // session.collected.ticketId = ticket.id;
//       // session.messages.push({ role: "assistant", content: `Ticket created: ${ticket.id}`});
//     }

//     return res.json({ sessionId: session.id, text: assistantText, collected: session.collected });

//   } catch (err) {
//     console.error(err);
//     return res.status(500).json({ error: err?.message || "server error" });
//   }
// });

// /* cleanup stale sessions every hour (12h timeout) */
// setInterval(() => {
//   const cutoff = Date.now() - (12 * 60 * 60 * 1000);
//   for (const [k, v] of sessions.entries()) {
//     if (new Date(v.lastSeen).getTime() < cutoff) sessions.delete(k);
//   }
// }, 60 * 60 * 1000);

// app.listen(PORT, () => console.log(`Agent server listening on http://localhost:${PORT}`));
// server.js
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
if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);

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

/* ---------------- In-memory sessions (replace with Redis for production) ---------------- */
const sessions = new Map();

/* ---------------- Knowledge base (moved into system prompt) ----------------
   NOTE: keep KB concise to avoid excessive prompt length. For large KB, consider retrieval.
*/
const BRAND = "InfiNET Broadband";

const KB = `
Knowledge base for ${BRAND} (use this to answer customer calls and chats concisely):

- Greeting / Routing:
  "Thanks for calling InfiNET Broadband, how may we help you? Would it be sales, support, or accounts?"
  If caller says sales/support/accounts, proceed accordingly and collect structured fields.

- Payment & Portal:
  "Did you know you can update your payment method via the customer portal?"
  If the customer does not have portal access, tell them: "If you don’t have access to the customer portal, please email support@infinetbroadband.com.au and our team will issue you the login credentials."

- Support contact:
  "If you are having issues with your Internet service please email support@infinetbroadband.com.au and our support team will be able to assist you."

- NBN vs OptiComm:
  "Both NBN and OptiComm deliver fibre internet in Australia. The main difference is availability: NBN is the national wholesale network while OptiComm is a private fibre network available in selected estates and buildings. Both offer similar speeds. InfiNET Broadband can connect you to either depending on what's available at your address."

- Common Qs to answer concisely:
  * Can I use my own or existing modem (BYO Modem) on the NBN & Opticomm Internet services?
    - Answer: Yes, you can bring your own compatible modem. If you’re unsure, our support team can help check compatibility. We also offer modems for purchase if you prefer a hassle-free setup.
  * Do you offer unlimited data on NBN & Opticomm Internet?
    - Answer: Yes, all of our NBN and OptiComm internet plans come with unlimited data. Stream, work, and play without worrying about data limits or excess charges.
  * How fast is NBN compared to OptiComm?
    - Answer: Speeds depend on your chosen plan. Both NBN and OptiComm can deliver speeds from 25 Mbps up to 1,000 Mbps in some areas. OptiComm may offer higher speeds in certain fibre-enabled estates, while NBN is more widely available across Australia.
  * How long does setup take to setup NBN or Opticomm?
    - Answer: In most cases, either NBN or Opticomm services can be activated within 30mins to 3 hours if your premises has already been connected. If your premise has never been connected before (new home or building) a tech visit is required, it may take a little longer as some new homes required an NTD (Network Termination Device) to be installed and this requires an onsite tech visit to be booked in by one of our team members. Our team will guide you through every step.
  * How do I check if my home has OptiComm?
    - Answer: They can check OptiComm coverage on the OptiComm website or ask InfiNET and we'll confirm quickly.

- Tone:
  * Always concise and professional.
  * Ask only one short question when collecting missing info.
  * Respect consent: ask once if no consent given; if consent given, record it in session.
  * When ready to create a ticket/lead, return explicit action or instruct handover.

- Contact info to use:
  * support@infinetbroadband.com.au

End KB.
`;

/* ---------------- System prompt (includes KB) ---------------- */
const SYSTEM_PROMPT = `
You are a concise, professional voice/chat assistant for ${BRAND}.
Handle four call types / chat intents: support, sales, general, account.
Rules:
- Always reply in English.
- Keep replies short and focused; ask one thing at a time.
- Respect consent: if user hasn't consented to recording/transcript, request consent once and wait.
- Collect structured fields when appropriate and do not re-ask for already collected fields.
- If sufficient info for an action (create ticket or lead), return an explicit action result (via the extraction function) or indicate next step.
- When handing over to a human, set a "handover" flag in the response or say "I'll forward this to a human".
- Use the KB below to answer user questions. If user asks a direct KB-like question, answer concisely using KB facts.
${KB}
`;

/* ---------------- Function schema for extraction (function calling) ---------------- */
const extractFunction = {
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

/* ---------------- Utilities ---------------- */
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

/* ---------------- Splynx / CRM helper stubs (placeholders) ----------------
   Implement these to actually call Splynx API / CRM.
*/
const Splynx = {
  async findCustomerByPhone(phone) { return null; },
  async createCustomer(payload) { return { id: "cust_stub_id", ...payload }; },
  async createTicket(payload) { return { id: "ticket_stub_id", ...payload }; },
  async appendTicketMessage(ticketId, message) { return true; }
};

/* ---------------- Apply extraction ---------------- */
function applyExtractionToSession(session, parsed) {
  const extractionResult = numbersToInt(parsed || {});
  for (const [k,v] of Object.entries(extractionResult)) {
    if (k === "consent" && v === true) session.consent = true;
    else if (v !== undefined && v !== null) session.collected[k] = v;
  }
  session.lastSeen = new Date().toISOString();
  sessions.set(session.id, session);
  return extractionResult;
}

/* ---------------- TTS helper ---------------- */
async function makeTTS(text) {
  try {
    const tts = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "cedar",
      input: text,
      format: "mp3"
    });
    const buf = await streamToBuffer(tts);
    return buf;
  } catch (err) {
    console.warn("TTS failed:", err?.message || err);
    return null;
  }
}

/* ---------------- Chat init: return session id + greeting audio/text ---------------- */
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

/* ---------------- Voice endpoint ----------------
   Flow: upload audio -> skip conversion if webm -> transcribe -> function-call extraction -> final assistant reply -> tts mp3 base64
*/
// app.post("/api/voice", upload.single("audio"), async (req, res) => {
//   const incomingSessionId = (req.body && req.body.sessionId) || req.query.sessionId || req.headers["x-session-id"] || null;
//   if (!req.file) return res.status(400).json({ error: "Missing audio file (multipart field 'audio')" });

//   const uploadedPath = path.resolve(req.file.path);
//   let convertedPath = null;

//   try {
//     const session = (incomingSessionId && sessions.has(incomingSessionId)) ? sessions.get(incomingSessionId) : mkSession(incomingSessionId);

//     // accept consent from client checkbox
//     const consentField = (req.body && req.body.consent);
//     if (consentField === "true" || consentField === true) session.consent = true;

//     // Use webm/ogg directly when uploaded from browser to reduce latency
//     const mimetype = req.file.mimetype || "";
//     if (mimetype.includes("webm") || uploadedPath.endsWith(".webm") || uploadedPath.endsWith(".ogg") || uploadedPath.endsWith(".opus")) {
//       convertedPath = uploadedPath; // skip conversion
//     } else {
//       convertedPath = await convertToWav(uploadedPath);
//     }

//     // Transcribe with OpenAI
//     const transcriptionResp = await openai.audio.transcriptions.create({
//       file: fs.createReadStream(convertedPath),
//       model: "gpt-4o-mini-transcribe"
//     });

//     const userTextRaw = normalizeText(transcriptionResp?.text || "");
//     if (!userTextRaw) {
//       const prompt = "Sorry, I didn't catch that — could you please repeat briefly?";
//       const ttsBuf = await makeTTS(prompt);
//       session.lastSeen = new Date().toISOString();
//       sessions.set(session.id, session);
//       return res.json({ sessionId: session.id, text: prompt, audioBase64: ttsBuf ? ttsBuf.toString("base64") : null });
//     }

//     session.messages.push({ role: "user", content: userTextRaw });

//     // local quick consent detection in speech transcript
//     const low = userTextRaw.toLowerCase();
//     const consentWords = ["yes","yeah","yep","sure","ok","okay","of course","i consent","record","نعم","ہاں","si","oui"];
//     if (consentWords.some(w => low.includes(w))) {
//       session.consent = true;
//       session.messages.push({ role: "assistant", content: "User gave consent to record." });
//     }

//     // function-call extraction attempt (let the model use the KB in the system prompt)
//     let extractionResult = null;
//     try {
//       const funcResp = await openai.chat.completions.create({
//         model: "gpt-4o-mini",
//         messages: session.messages,
//         functions: [extractFunction],
//         function_call: "auto",
//         temperature: 0.0,
//         max_tokens: 300
//       });

//       const choice = funcResp.choices?.[0];
//       const msg = choice?.message;
//       if (msg) {
//         if (msg.function_call && msg.function_call.arguments) {
//           const parsed = safeParseJSON(msg.function_call.arguments);
//           if (parsed) {
//             extractionResult = applyExtractionToSession(session, parsed);
//             session.messages.push(msg);
//           }
//         } else if (msg.content) {
//           session.messages.push({ role: "assistant", content: msg.content });
//           const assistantText = msg.content;
//           const ttsBuf = await makeTTS(assistantText);
//           sessions.set(session.id, session);
//           return res.json({ sessionId: session.id, text: assistantText, audioBase64: ttsBuf ? ttsBuf.toString("base64") : null });
//         }
//       }
//     } catch (err) {
//       console.warn("Function extraction failed:", err?.message || err);
//     }

//     // Compose final reply (model sees the KB via system prompt; it should answer using KB when possible)
//     const collectedSummary = `CollectedFields: ${JSON.stringify(session.collected || {})}. Consent: ${session.consent === true}.`;
//     const followupSystem = `You are a concise assistant. Use collected fields and do not re-ask already present info. If missing, ask one short question. Reply in English.`;

//     const finalMessages = [
//       { role: "system", content: followupSystem },
//       ...session.messages,
//       { role: "system", content: collectedSummary }
//     ];

//     const finalResp = await openai.chat.completions.create({
//       model: "gpt-4o-mini",
//       messages: finalMessages,
//       temperature: 0.0,
//       max_tokens: 350
//     });

//     const assistantText = finalResp.choices?.[0]?.message?.content?.trim() ||
//                           `Thanks — I have your details. A human agent can contact you to continue.`;

//     session.messages.push({ role: "assistant", content: assistantText });

//     const ttsBuf = await makeTTS(assistantText);

//     session.lastSeen = new Date().toISOString();
//     sessions.set(session.id, session);

//     return res.json({ sessionId: session.id, text: assistantText, audioBase64: ttsBuf ? ttsBuf.toString("base64") : null });

//   } catch (err) {
//     console.error("server error:", err);
//     return res.status(500).json({ error: err?.message || "server error" });
//   } finally {
//     try { if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath); } catch(_) {}
//     try { if (convertedPath && convertedPath !== uploadedPath && fs.existsSync(convertedPath)) fs.unlinkSync(convertedPath); } catch(_) {}
//   }
// });
// Replace only the /api/voice route in your server.js with this version.

app.post("/api/voice", upload.single("audio"), async (req, res) => {
  const incomingSessionId = (req.body && req.body.sessionId) || req.query.sessionId || req.headers["x-session-id"] || null;
  if (!req.file) return res.status(400).json({ error: "Missing audio file (multipart field 'audio')" });

  const uploadedPath = path.resolve(req.file.path);
  let convertedPath = null;

  try {
    const session = (incomingSessionId && sessions.has(incomingSessionId)) ? sessions.get(incomingSessionId) : mkSession(incomingSessionId);

    // accept consent from client checkbox
    const consentField = (req.body && req.body.consent);
    if (consentField === "true" || consentField === true) session.consent = true;

    // --- ALWAYS convert to WAV unless it's already WAV ---
    // This avoids "Unsupported file format" errors from the transcription API.
    const origName = (req.file.originalname || "").toLowerCase();
    const mimetype = (req.file.mimetype || "").toLowerCase();

    const looksLikeWav = origName.endsWith(".wav") || mimetype === "audio/wav" || mimetype === "audio/wave" || mimetype === "audio/x-wav";
    if (looksLikeWav) {
      // if it's already WAV, skip conversion (small optimization)
      convertedPath = uploadedPath;
    } else {
      // convert everything to a standard 16kHz mono WAV
      convertedPath = await convertToWav(uploadedPath);
    }

    // Transcribe with OpenAI (pass the converted WAV)
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

    // let the model extract fields and reply (function-calling path, then final reply)
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
    // helpful debug logging for format errors
    console.error("server error:", err);
    // If it's an OpenAI response error with headers, attach a friendly summary
    if (err && err?.error && err.error.message) {
      return res.status(500).json({ error: err.error.message, details: err?.message });
    }
    return res.status(500).json({ error: err?.message || "server error" });
  } finally {
    // clean up files (keep convertedPath check)
    try { if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath); } catch(_) {}
    try { if (convertedPath && convertedPath !== uploadedPath && fs.existsSync(convertedPath)) fs.unlinkSync(convertedPath); } catch(_) {}
  }
});
/* ---------------- Chat message endpoint (widget) ---------------- */
app.post("/api/chat/message", async (req, res) => {
  try {
    const { sessionId, message, channel = "web" } = req.body;
    if (!message) return res.status(400).json({ error: "Missing message" });

    const session = (sessionId && sessions.has(sessionId)) ? sessions.get(sessionId) : mkSession(sessionId);
    session.messages.push({ role: "user", content: message });

    // quick consent detect
    const low = message.toLowerCase();
    const consentWords = ["yes","agree","okay","ok","i consent","record"];
    if (consentWords.some(w => low.includes(w))) {
      session.consent = true;
      session.messages.push({ role: "assistant", content: "User gave consent to record." });
    }

    // function extraction / model reply (model will use KB from system prompt)
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

    // demonstrate potential ticket creation (left as stub)
    if (session.collected.intent === "support" && session.collected.issueSummary && session.consent) {
      // Example: const ticket = await Splynx.createTicket({...}); session.collected.ticketId = ticket.id;
    }

    return res.json({ sessionId: session.id, text: assistantText, collected: session.collected });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "server error" });
  }
});

/* cleanup stale sessions every hour (12h timeout) */
setInterval(() => {
  const cutoff = Date.now() - (12 * 60 * 60 * 1000);
  for (const [k, v] of sessions.entries()) {
    if (new Date(v.lastSeen).getTime() < cutoff) sessions.delete(k);
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => console.log(`Agent server listening on http://localhost:${PORT}`));