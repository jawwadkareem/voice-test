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
const PORT = process.env.PORT || 3003;
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
const sessions = new Map();
const BRAND = "InfiNET Broadband";
const KB = `
Knowledge base for ${BRAND} (use this to answer customer calls and chats concisely):
- Greeting / Routing:
  "Thanks for calling InfiNET Broadband, how may we help you? Would it be sales, support, or accounts?"
  If caller says sales/support/accounts, proceed accordingly and collect structured fields.
- Payment & Portal:
  "Did you know you can update your payment method via the customer portal?"
  If the customer does not have portal access, tell them: "If you don't have access to the customer portal, please email support@infinetbroadband.com.au and our team will issue you the login credentials."
- Support contact:
  "If you are having issues with your Internet service please email support@infinetbroadband.com.au and our support team will be able to assist you."
- Plan change / Upgrade:
  "Did you want to upgrade or change the internet plan you are on? Please just email support@infinetbroadband.com.au and our support team will be able to assist you."
- Outstanding / Overdue invoice:
  "Do you have an outstanding or overdue invoice? If so, just login to the customer portal to manually pay this. You can also log a support ticket via support@infinetbroadband.com.au and our accounts team will be able to assist you."
- Payment details changed / lost card / new bank:
  "Have your payment details changed, lost a card, or changed bank details? Just login to the customer portal to update this manually, or you can also log a support ticket via support@infinetbroadband.com.au and our accounts team will be able to assist you."
- Cannot login to portal:
  "Not able to login to the customer portal? Just email support@infinetbroadband.com.au and our accounts team will be able to assist."
- NBN vs OptiComm:
  "Both NBN and OptiComm deliver fibre internet in Australia. The main difference is availability: NBN is the national wholesale network while OptiComm is a private fibre network available in selected estates and buildings. Both offer similar speeds. InfiNET Broadband can connect you to either depending on what's available at your address."
- Opticomm Free to Air TV issue:
  "Infinet Broadband does not support your free to air television service. Please contact Opticomm directly — you can visit https://online.telco.opticomm.com.au/television-fault Thank you, goodbye."
- Common Qs to answer concisely:
  * Can I use my own or existing modem (BYO Modem) on the NBN & Opticomm Internet services?
    - Answer: Yes, you can bring your own compatible modem. If you're unsure, our support team can help check compatibility. We also offer modems for purchase if you prefer a hassle-free setup.
  * Do you offer unlimited data on NBN & OptiComm Internet?
    - Answer: Yes, all of our NBN and OptiComm internet plans come with unlimited data. Stream, work, and play without worrying about data limits or excess charges.
  * How fast is NBN compared to OptiComm?
    - Answer: Speeds depend on your chosen plan. Both NBN and OptiComm can deliver speeds from 25 Mbps up to 1,000 Mbps in some areas. OptiComm may offer higher speeds in certain fibre-enabled estates, while NBN is more widely available across Australia.
  * How long does setup take to setup NBN or Opticomm?
    - Answer: In most cases, either NBN or OptiComm services can be activated within 30mins to 3 hours if your premises has already been connected. If your premise has never been connected before (new home or building) a tech visit is required, it may take a little longer as some new homes required an NTD (Network Termination Device) to be installed and this requires an onsite tech visit to be booked in by one of our team members. Our team will guide you through every step.
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
Additional Knowledge Base – Concise Version
Payment Setup & Manual Payment
Customer portal: https://infinetbroadband-portal.com.au/
To set up recurring payment (Direct Debit or Credit/Debit Card):
1. Log in → Finance → Select payment method
2. Credit/Debit Card: Add card details → Save and allow future charges
3. Direct Debit: Add bank details → Save and allow future charges
→ Future invoices auto-debit on due date.
To manually pay an outstanding/overdue invoice (when auto-payment fails):
1. Log in → Dashboard or Finance/Documents
2. Select invoice/document (use dropdown to filter types)
3. Click ✓ → Choose Credit Card or Direct Debit → Pay
→ Marks invoice PAID once cleared.
NBN FTTP Upgrade (from March 2022 onward)
• Upgrades eligible FTTN / FTTC premises to FTTP (direct fibre to premises)
• $0 standard installation if signing to eligible high-speed plan (min 100/20 Mbps)
• Non-standard installs may incur costs (NBN advises & seeks approval first)
• Contact InfiNET to check eligibility → we handle the request
Key NBN Technologies – Summary
• FTTP (Fibre to the Premises): Fibre direct to home. Requires NTD inside + utility box outside. Best speeds/reliability.
• FTTN (Fibre to the Node): Fibre to street node → copper to home. Uses DSL port on modem.
• FTTC (Fibre to the Curb): Fibre to pit/DPU → short copper to home. Uses NCD + ethernet to router WAN.
• FTTB (Fibre to the Building): Fibre to building comms room → copper to unit/apartment. DSL modem.
• HFC (Hybrid Fibre Coaxial): Uses existing cable TV coax. Coax to NTD → ethernet to router WAN.
• Fixed Wireless: Radio from tower (up to ~14 km) → outdoor antenna → NTD inside.
• Satellite (Sky Muster): Satellite dish → indoor modem/NTD.
Modem/Router Connection – General Rules
• FTTP / FTTC / HFC / Fixed Wireless / Satellite / OptiComm: Connect router WAN port to NBN NTD/NCD UNI-D port (ethernet cable). NBN-ready router required.
• FTTN / FTTB: Connect DSL port to phone wall socket (VDSL/ADSL modem required).
Service Classes – Quick Overview (NBN)
Higher class = more infrastructure already in place → faster activation
FTTP / FTTB / FTTC / HFC
• 0 = Future serviceable, not ready yet (pre-order possible)
• 1 = Serviceable, no equipment yet → book install
• 2 = External installed, internal pending → book install
• 3 = Fully installed → activate 1–5 days
FTTN similar but uses Class 10–13 (copper-based readiness)
Fixed Wireless: Class 4–6
Satellite: Class 7–9
(Details mirror pattern above)
OptiComm FTTP Classes
• 0 = Future, not ready
• 1 = Serviceable, no equipment → contact OptiComm directly first
• 2 = External done, internal pending → order + pay new connection fee ($330–$550 inc GST first time only)
• 3 = Fully installed → activate 1–2 days
• 5 = Fully installed + New Development Fee $300 inc GST (first time)
TP-Link VX230v Router (InfiNET supplied – pre-configured plug & play)
If factory reset → must reconfigure:
LEDs (left to right): Power, DSL, Internet, 2.4G, 5G, WAN, LAN1–3, WPS, USB, Phone
Access admin portal: http://tplinkmodem.net or http://192.168.1.1
(Initial password: contact InfiNET if reset)
Quick Setup after reset:
• Region & Time Zone
• ISP = Other
• Connection: EWAN (FTTP/FTTC/HFC/OptiComm) or VDSL (FTTN/FTTB)
• Use settings supplied by InfiNET at activation
• Wireless: leave default or customise later
• Run connection test
Change settings later: Internet tab (EWAN/DSL) or Wireless tab (SSID/password).
Mesh Wi-Fi (HX220/510 extenders):
• Wireless: Add via Network Map → place near VX230 (flashing blue) → auto-pair
• Ethernet backhaul: Connect HX WAN → VX230 LAN → auto-detects
VoIP (if subscribed):
Telephony → Telephone Number → Add/Modify → enter InfiNET-provided VoIP credentials
General Advice
• Check address/technology: Use InfiNET "Check your Address" tool or ask support
• Unsure about modem compatibility, settings, VoIP, etc. → email support@infinetbroadband.com.au
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
      model: "tts-1",
      voice: "nova",
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
    // --- Convert to WAV always, unless it's already WAV (to avoid format issues with webm) ---
    const origName = (req.file.originalname || "").toLowerCase();
    const mimetype = (req.file.mimetype || "").toLowerCase();
    const looksLikeWav = origName.endsWith(".wav") || mimetype === "audio/wav" || mimetype === "audio/wave" || mimetype === "audio/x-wav";
    if (looksLikeWav) {
      convertedPath = uploadedPath;
    } else {
      convertedPath = await convertToWav(uploadedPath);
    }
    // Transcribe with OpenAI (pass the converted WAV)
    const transcriptionResp = await openai.audio.transcriptions.create({
      file: fs.createReadStream(convertedPath),
      model: "whisper-1"
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
    // Single LLM call for extraction and response
    const collectedSummary = `CollectedFields: ${JSON.stringify(session.collected || {})}. Consent: ${session.consent === true}.`;
    const combinedSystem = `${SYSTEM_PROMPT}\n\nOutput in JSON format: {"extraction": {fields here, omit absent}, "response": "concise reply here"}. Use collected fields, ask only one missing info if needed.`;
    const finalMessages = [
      { role: "system", content: combinedSystem },
      ...session.messages,
      { role: "system", content: collectedSummary }
    ];
    const finalResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: finalMessages,
      temperature: 0.0,
      max_tokens: 200
    });
    const outputText = finalResp.choices?.[0]?.message?.content?.trim() || "{}";
    const parsedOutput = safeParseJSON(outputText);
    let assistantText = "Thanks — I have your details. A human agent can contact you to continue.";
    if (parsedOutput) {
      if (parsedOutput.extraction) {
        applyExtractionToSession(session, parsedOutput.extraction);
      }
      if (parsedOutput.response) {
        assistantText = parsedOutput.response;
      }
    }
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
    // Single LLM call for extraction and response
    const collectedSummary = `CollectedFields: ${JSON.stringify(session.collected || {})}. Consent: ${session.consent === true}.`;
    const combinedSystem = `${SYSTEM_PROMPT}\n\nOutput in JSON format: {"extraction": {fields here, omit absent}, "response": "concise reply here"}. Use collected fields, ask only one missing info if needed.`;
    const finalMessages = [
      { role: "system", content: combinedSystem },
      ...session.messages,
      { role: "system", content: collectedSummary }
    ];
    const finalResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: finalMessages,
      temperature: 0.0,
      max_tokens: 200
    });
    const outputText = finalResp.choices?.[0]?.message?.content?.trim() || "{}";
    const parsedOutput = safeParseJSON(outputText);
    let assistantText = "Thanks — I have your details. A human agent can contact you to continue.";
    if (parsedOutput) {
      if (parsedOutput.extraction) {
        applyExtractionToSession(session, parsedOutput.extraction);
      }
      if (parsedOutput.response) {
        assistantText = parsedOutput.response;
      }
    }
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