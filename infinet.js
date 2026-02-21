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

// const KB = `
// Knowledge base for ${BRAND} (use this to answer customer calls and chats concisely):
// - Greeting / Routing:
//   "Thanks for calling InfiNET Broadband, how may we help you? Would it be sales, support, or accounts?"
//   If caller says sales/support/accounts, proceed accordingly and collect structured fields.
// - Payment & Portal:
//   "Did you know you can update your payment method via the customer portal?"
//   If the customer does not have portal access, tell them: "If you don’t have access to the customer portal, please email support@infinetbroadband.com.au and our team will issue you the login credentials."
// - Support contact:
//   "If you are having issues with your Internet service please email support@infinetbroadband.com.au and our support team will be able to assist you."
// - NBN vs OptiComm:
//   "Both NBN and OptiComm deliver fibre internet in Australia. The main difference is availability: NBN is the national wholesale network while OptiComm is a private fibre network available in selected estates and buildings. Both offer similar speeds. InfiNET Broadband can connect you to either depending on what's available at your address."
// - Common Qs to answer concisely:
//   * Can I use my own or existing modem (BYO Modem) on the NBN & Opticomm Internet services?
//     - Answer: Yes, you can bring your own compatible modem. If you’re unsure, our support team can help check compatibility. We also offer modems for purchase if you prefer a hassle-free setup.
//   * Do you offer unlimited data on NBN & OptiComm Internet?
//     - Answer: Yes, all of our NBN and OptiComm internet plans come with unlimited data. Stream, work, and play without worrying about data limits or excess charges.
//   * How fast is NBN compared to OptiComm?
//     - Answer: Speeds depend on your chosen plan. Both NBN and OptiComm can deliver speeds from 25 Mbps up to 1,000 Mbps in some areas. OptiComm may offer higher speeds in certain fibre-enabled estates, while NBN is more widely available across Australia.
//   * How long does setup take to setup NBN or Opticomm?
//     - Answer: In most cases, either NBN or OptiComm services can be activated within 30mins to 3 hours if your premises has already been connected. If your premise has never been connected before (new home or building) a tech visit is required, it may take a little longer as some new homes required an NTD (Network Termination Device) to be installed and this requires an onsite tech visit to be booked in by one of our team members. Our team will guide you through every step.
//   * How do I check if my home has OptiComm?
//     - Answer: They can check OptiComm coverage on the OptiComm website or ask InfiNET and we'll confirm quickly.
// - Tone:
//   * Always concise and professional.
//   * Ask only one short question when collecting missing info.
//   * Respect consent: ask once if no consent given; if consent given, record it in session.
//   * When ready to create a ticket/lead, return explicit action or instruct handover.
// - Contact info to use:
//   * support@infinetbroadband.com.au
// End KB.

// --- Additional knowledge (appended exactly as requested) ---

// Set-up a Payment Method
// Here are the steps to set-up the payment method for recurring payments or one-time invoices.
// 1. Go to the customer login portal (https://infinetbroadband-portal.com.au/)
// 2. Login with the supplied username and password
// 3. Once logged in, click on Finance, then select your payment method (Direct Debit or Credit/Debit card)
// 4. Using the Credit/Debit card. Select the “Add Credit/Debit Card” option, click in and complete the fields “Cardholder Name” + “Card Number” + “Exp to:” & “CVV” within the spaces provided. Once filled in, click “Save and allow future changes”. This will then save your payment method and all future invoices will be debited automatically on the payment date using this payment method.
// 5. Using the Direct Debit. Select the “Add Direct Debit Details” option and then add your bank details. Once filled in, click “Save and allow future changes”. This will then save your payment method and all future invoices will be debited automatically on the payment date using this payment method.

// InfiNET Broadband - Manually paying an invoice
// Here are the steps to pay an outstanding or overdue invoice, where the automatic payment method failed to process the credit card or Direct Debit.
// 1. Go to the customer login portal (https://infinetbroadband-portal.com.au/)
// 2. Login with the supplied username and password
// 3. Once logged in, you can pay your account balance or invoice using the two methods indicated below from the dashboard or from the Finance/Documents menu. Click on the ✓ icon, select Credit Card or Direct Debit depending on what has been set-up.
//    Note: You can select what documents are displayed using the dropdown box in the top right hand corner of the page, it defaults to show “All Types”
// 4. The following screens are opened depending on what payment type you want to pay with. The invoice amount is showing and then click on the “Pay” button. This will process the payment and once cleared, mark the outstanding invoice as “PAID”

// NBN® Fibre to the Premise Upgrade Explained
// What is happening?
// From March 2022, NBN will be upgrading more than 5 million businesses and homes using Fibre to the Node (FTTN) or Fibre to the Curb (FTTC) premises to Fibre to the Premises (FTTP) enabling access to NBN’s ultrafast, on demand plans.
// To trigger an FTTP upgrade, customers just need to contact InfiNET Broadband to see if you are eligible, we will then do the rest for you!
// How much does the NBN FTTP Upgrade Cost
// All eligible addresses where a standard installation is required, can upgrade for a $0 installation.
// You will need to sign up to one of InfiNET eligible high speed plans (Minimum speed plan to avail of the free upgrade is the 100/20Mbps)
// Note: NBN will determine if an eligible address requires a non-standard installation. If the FTTP upgrade requires additional costs to complete the upgrade, NBN will advise before upgrading and approval is sought from the customer.
// What is the FTTN, FTTC & FTTP NBN technology differences?
// * Fibre to the Node (FTTN) – This connection is utilised where the existing copper phone and internet network from a nearby fibre node is used to make the final part of the connection to the nbn™ access network. In this scenario, a fibre optic line is run to the fibre node in the street, then the existing technology (copper cabling) in used to connect to the premise.
// * Fibre to the Curb (FTTC) – connection is used in circumstances where fibre is extended close to your premises, connecting to a small Distribution Point Unit (DPU), generally located inside a pit on the street. From here, the existing copper network is connected to the fibre to form the final NBN™ connection into your premise. This will terminate into a NBN NCD (Network Connection Device.
// * Fibre to the Premises (FTTP) – This connection types uses a fibre optic line run from the nearest available fibre node, directly to your premises. FTTP connections require an nbn™ utility box on the outside wall and an access network device to be installed inside your home. This device requires power to operate and can only be installed by an approved nbn™ installer or phone and internet provider.
// What’s involved in the NBN FTTP Upgrade Installation
// Additional work will be required to install new NBN equipment inside and outside of the premises to complete the fibre upgrade. There could be temporary service interruptions during the installation as NBN are working with a live network
// Installation appointment
// The nbn® approved technician will arrive to install the nbn® equipment inside and outside your premises. You, or an authorised person over the age of 18, will need to be present during the installation to give the technician both internal and external access to your premises. If you’re renting, make sure that you have the landlord or property manager’s verbal or written permission before the appointment. The technician may need to do work that will need approval – such as drilling into the property walls.
// What to expect during the installation appointment?
// * In most cases, this appointment will take between 3 to 4 hours. Please note it could take longer for complex connections.
// * Activities performed by the technician includes installing and testing of the nbn®equipment inside and outside your premises
// * The technician will advise on the best location to install the nbn®connection box inside your premises. You can speak to the technician about your options.
// What happens during the installation appointment?
// Activities performed by the nbn®approved technician include:
// * Installation of the nbn®fibre lead-in along with the nbn® utility box and the drop cable (if it wasn’t installed during the pre-installation visit)
//   * Installation of the nbn®connection box (inside or outside) and a Power Supply Unit (inside) your premises. The technician will advise on the best location to install this equipment (close to a power source, cool and dry, won’t get knocked)
//   * Testing of the nbn®FTTP service to the nbn® connection box so that it’s ready for InfiNET Broadband to finalise the connection
// The Pre-installation Visit (Not always required)
// Here the nbn® approved technician will assess the outside of your premises. This will help us to identify any obstacles early and prepare for your upcoming installation appointment. The technician may find that additional pre-installation work is needed. NBN’s aim is to either return before your scheduled installation appointment or complete the work during the installation appointment.
// What to expect during the pre-installation visit?
// * In most cases, this visit will take on average between 45 minutes to 1.5 hours. Please keep in mind that complex connections may take longer.
// * You, or an authorised person over the age of 18, do not need to be present for this appointment.
// * If you’re renting, make sure that you have the landlord or property manager’s verbal or written permission before the visit. The technician may need to do work that will need approval – such as drilling into the property walls.
// What happens during the pre-installation visit?
// Activities performed by the nbn®approved technician include:
// * Review of the external nbn®infrastructure on the street and civil works (as needed), such as clearage of any blockages in the pathway leading to your premises
//   * Non-invasive construction activities such as hand digging, to remove blockages, and reinstatement of the land on or near your premises
//   * Installation of nbn®fibre lead-in where required
//   * Installation of nbn®utility box on the outside wall, so that there’s less to do during the installation appointment (if you’re present for the visit and with your consent)
//   * Network civil works, including installation of the splitter multiport for the nbn®FTTC which requires a planned outage of around 30 minutes
// NBN FTTP Hardware
// Connecting a Modem/Router to a FTTP service
// The following diagram outlines how to connect the modem/router to a FTTB service. You will require a NBN ready router.
// 1. Power Port – Connection port for the Power
// 2. UNI D & WAN Port – Is the port to connect the router to the NBN NCB UNI D port*
// 3. Power Button – Button to turn the modem/router off/on
// 4. UNI V 1 Port/s – To connect a telephone directly into the router

// *You can have up to 4 active NBN services connected at the same time

// NBN FTTN Technology Explained
// Which NBN technology is available in my area?
// You can check your address using our “Check your Address” to see if NBN is available and what connection type is available?
// What is the FTTN NBN technology?
// Fibre to the Node (FTTN) – This connection is utilised where the existing copper phone and internet network from a nearby fibre node is used to make the final part of the connection to the nbn™ access network. In this scenario, a fibre optic line is run to the fibre node in the street, then the existing technology (copper cabling) in used to connect to the premise.
// Connecting a Modem/Router to a FTTN service – The following diagram outlines how to connect the ADSL/VDSL modem/router to a FTTN service. You will require a NBN ready ADSL/VDSL router that has a DSL port.
// 1. Power Port – Connection port for the Power
// 2. DSL Port – Is the port to connect the telephone cable from the phone line socket
// 3. Phone Port/s – Is the port to connect a DECT phone into
// 4. Power Button – Button to turn the modem/router off/on
// 5. LAN Ports – To connect network, VoIP etc. devices into the router

// TP-Link VX230v Install Guide
// * 1. TP-Link VX230 LED Indicators Explained
// * 2. TP-Link VX230 Ports Explained
// * 3. Connecting to the TP-Link VX230v
// * 4. Accessing the administration portal
// * 5. TP-Link VX230vConfiguration
// * 6. Adding a TP-Link HX220/510 (Wireless)
// * 7. Adding a TP-Link HX220/510 (Ethernet)
// * 8. Configuring the VoIP Telephone
// Please note that your InfiNET Broadband supplied TP-Link VX230v router will come pre-configured with the settings to allow you to simply connect the router and have Plug-n-Play internet access. If you have factory reset your router, the following steps are required to reconfigure your TP-Link VX230v router.
// 1. TP-Link VX230 LED Indicators Explained
// LED Indicators (Left to Right)
// * Power
// * DSL
// * Internet
// * 2.4Ghz Wi-Fi
// * 5Ghz W-Fi
// * WAN
// * LAN1
// * LAN2
// * LAN3
// * WPS
// * USB
// * Phone
// 2. TP-Link VX230 Ports Explained
// 3. Connecting to the TP-Link VX230v
// When configuring your TP-Link VX230, it is recommended to connect your device directly to TP-Link modem with the wired Ethernet cable. If this is not possible you can connect your device via Wi-Fi
// 3.1 Connecting via an Ethernet Cable
// Once the VX230v is connected successfully to power you can easily connect an Ethernet cable from the LAN ports to the Ethernet port of your computer or laptop. Please note, if using a Macbook or iMac you will need a Thunderbolt to Ethernet adapter to connect via this method
// 3.2 Connecting via Wi-Fi
// Using your wireless device (e.g. computer), search for available wireless networks and select the network called TP-Link_XXXX (XXXX is a random 4 digit alpha-numeric code assigned to your VX230v). You can also select the network TP-Link_XXXX_5G if you wish to connect to 5GHz network which offers faster Wi-Fi speed (if your device supports it) then enter the Security Key. By default, the security key can be found printed on the barcode sticker on the underside of the device, click ‘connect’ or ‘join’
// 4. Accessing the administration portal
// Once you’ve successfully connected to the VX230 via a Wi-Fi or Ethernet cable, you will be able to access the device using either of these URLs via a web-browser;
// * http://tplinkmodem.net
// * http://192.168.1.1
// The first page you will reach is a page to set the password to your router. The VX230 access credentials will be one of two options:
// * Router when Preconfigured – Password is set and provided by InfiNET
// * Router when Factory Reset – The password will need to be reset. Contact InfiNET to obtain original password
// Once you have set the password, you will need to enter it on the login page
// 5. TP-Link VX230v Configuration
// 5.1 Initial set-up after factory reset
// Once logged into the VX230 administration router portal you will be taken to the Quick Setup wizard.
// Select your Region and Time Zone. Once done, click the Next button
// Next, select your Internet Service Provider (ISP), please select the option for Other. Once done, please click the Next button
// Under Internet Setup, the settings required for this are different for each connection. This is supplied in the initial configuration settings InfiNET send out when your service is activated. If you can’t find this or are not sure which technology type your service uses, please contact InfiNET for further support. Once configured, please click Next
// * EWAN = Connects using the TP-Link WAN Port (Ethernet Cable)
//   * NBN FTTP/FTTC/HFC/Opticomm/HIR technologies*
// * VDSL = Connects using the TP-Link DSL Port (phone cable)
//   * NBN FTTB/FTTN technologies*
// *Visit InfiNET Broadbands HELP section for explanations of Technologies Explained
// Under the Wireless Settings leave this section as the default settings. Once done, click the Next button.
// The next step is the Connection Test, this will confirm if the details you have entered as well as how the device is plugged in are correct and you are able to connect to the internet. If all goes to plan, you will get the following. Then please click the Next button.
// If you receive the “Sorry!” message, please click Next button to continue. At the end of the Wizard, please contact InfiNET and we will be more than happy to assist resolving the issue/s.
// The next page will show the summary of the setup you have just completed. Please click the Next button.
// The next page is only required if you have purchased a VoIP Phone service through InfiNET and use the TP-Link to connect the DECT phone to. Please click Next button to continue. At the end of the Wizard, please contact InfiNET and we will be more than happy to assist configuring this for you or see Section 8 in this guide
// More information of VoIP Phones and pricing, just visit our website here:
// * Residential VoIP Phone Plans
// * Business VoIP Phone Plans
// * Business VoIP System Features
// The final screen/step is the TP-Link Cloud Service Please just click on Log In Later If you would like to sign up you are welcome to. Please note any support on this will require contacting TP-Link Support
// If you receive the “Failed.” message, please click Finish button to continue. At the end of the Wizard, please contact InfiNET and we will be more than happy to assist resolving the issue/s
// 5.2 Modifying/Updating Internet Connection Settings
// To check or update the TP-Link VX230 internet settings, login to the modem as shown in Section 4 of this document.
// Click on the Internet Tab and select EWAN or DSL depending on the technology type at your service address
// From the Internet Connection Type drop down, select the type required. This information is supplied in the initial configuration settings InfiNET send out when your service is activated. If you can’t find this or are not sure which technology type your service uses, please contact InfiNET for further support. Once configured, please click Next
// 5.3 Modifying/Updating Wireless Settings
// If you want or need to change the TP-Link VX230 wireless settings, login to the modem as shown in Section 4 of this document. Here you can change the name of the network name (SSID) and the password.
// 6. Adding a TP-Link HX220/510 (Wireless)
// The TP-Link VX230 allows you to add additional HX220/510 access points to create a Wi-Fi mesh network to increase the coverage of your Wi-Fi network and remove dead-zones.
// To do this, login to the TP-Link VX230 modem as shown in Section 4 of this document. Under the Network Map tab, click on Add Mesh Device button
// Make sure that you have the TP-Link HX220/510 unit powered on and sitting close to the main TP-Link VX230 (within 1m) with the LED flashing blue.
// The Add more Mesh Devices pop up will appear. Following the instructions outlined
// Once the new TP-Link HX220/510 is successfully added. You can add more or click Finish
// Once the TP-Link HX220/510 is connected and you click “Finish” you will see the new HX220/510 showing connected under the Topology.
// Note: Please leave the HX220/510 in place and powered on, for at least 2-3mins until the LED stops flashing blue and goes to a solid white. Once the TP-Link HX220/510 has a white LED, you can power if off and re-locate it. It must stay in range of the TP-Link VX230 to maintain the Mesh Network
// 7. Adding a TP-Link HX220/510 (Ethernet)
// The TP-Link VX230 allows you to add additional HX220/510 device/s to create a Wi-Fi mesh network to increase the coverage of your Wi-Fi network and remove dead-zones.
// Make sure that you have the TP-Link HX220/510 unit powered on, with the LED flashing blue. Connect the HX220 WAN port to one of the TP-Link VX230 LAN ports using an ethernet cable. Once correctly connected, the TP-Link HX220/510 LED will turn solid white.
// To check the connection, login to the TP-Link VX230 modem as shown in Section 4 of this document. Under the Network Map tab you will see the TP-Link HX220/510 connected (solid grey line indicates it’s connected using the Ethernet cable)
// 8. Configuring the VoIP Telephone
// The TP-Link VX230 allows you to configure a VoIP phone. To configure or check the VoIP Telephone settings supplied by InfiNET, click on the “Telephony” tab in the menu and select “Telephone Number”.
// To Add a new VoIP service, click on the “Add” button or if a VoIP service is already configured, click the “Modify” Icon next to that service
// Then check or add the VoIP settings supplied by InfiNET. If you do not have these, please contact us

// NBN FTTP Technology Explained
// Which NBN technology is available in my area?
// You can check your address using our “Check your Address” to see if NBN is available and what connection type is available?
// What is the FTTP NBN technology?
// Fibre to the Premises (FTTP) – This connection types uses a fibre optic line run from the nearest available fibre node, directly to your premises. FTTP connections require an nbn™ utility box on the outside wall and an access network device to be installed inside your home. This device requires power to operate and can only be installed by an approved nbn™ installer or phone and internet provider.
// Connecting a Modem/Router to a FTTP service – The following diagram outlines how to connect the modem/router to a FTTB service. You will require a NBN ready router.
// 1. Power Port – Connection port for the Power
// 2. UNI D & WAN Port – Is the port to connect the router to the NBN NCB UNI D port*
// 3. Power Button – Button to turn the modem/router off/on
// 4. UNI V 1 Port/s – To connect a telephone directly into the router

// *You can have up to 4 active NBN services connected at the same time

// NBN HFC Technology Explained
// Which NBN technology is available in my area?
// You can check your address using our “Check your Address” to see if NBN is available and what connection type is available?
// What is the HFC NBN technology?
// Hybrid Fibre Coaxial (HFC) – This connection is used in circumstances where the existing ‘pay TV’ or cable network can be used to make the final part of the nbn™ network connection. In this circumstance an HFC line will be run from the nearest available fibre node, to your premises. HFC connections require an nbn™ network device to be installed at the point where the line enters your home. This device requires power to operate.
// Connecting a Modem/Router to a HFC service – The following diagram outlines how to connect the modem/router to a HFC service. You will require a NBN ready modem/router.
// 1. Power Port – Connection port for the Power to the Modem/Router and NBN NCB
// 2. Phone Line Socket & Wall socket Port – Is the socket within your premise where the coaxial cable is terminated and connects to the NBN NCB
// 3. Gateway & WAN Port – Connect the NBN NCB to the WAN port on the router using an ethernet cable
// 4. Power Button – Button to turn the modem/router off/on
// 5. Phone Port/s – Is the port to connect a DECT phone into

// What is my service class and what does it mean?
// The ‘Service Class’ for your location is a way for the network provider to categorise and define how the internet is delivered to your address and identify what stages of installation has been completed.
// While it isn’t particularly important to know what your class is, learning these can be helpful for understanding how the internet is delivered to your premises.
// Click here to jump to the Opticomm section.
// NBN Service Classes
// Fibre to the Premises (FTTP)
// ClassDefinitonService Class 0The location will be serviceable by fibre (FTTP) in the future, but it’s not ready yet – NBN hasn’t finished connecting the local area. infiNET customers can pre-sign, but you will have to wait until the area is ready for service.Service Class 1The location is serviceable by fibre, however no NBN equipment has been installed at the premises yet. You’re able to order a service and an installation appointment can be made.Service Class 2The location is ready to connect with fibre technology. The external devices have been installed at the premises, but no internal equipment is installed yet. You’re able to order a service and an installation appointment can be made.Service Class 3The location is fully installed and serviceable by fibre, with both the external and internal devices installed at the premises. You can order a service and it will be activated in 1-5 days.
// Fixed Wireless (FW)
// ClassDefinitonService Class 4The location is planned to be serviceable by Fixed Wireless, but the tower is not built or ready for use. You can’t connect yet, but infiNET customers can pre-sign. You’ll have to wait for NBN to announce the area is ready for service.Service Class 5The location is now serviceable by NBN Fixed Wireless, but there’s no equipment installed at the premises. You are able to order a service and an installation appointment can be made.Service Class 6The location is ready to connect with Fixed Wireless technology. The antenna and the NTD (NBN connection device) are installed. You can order a service and it will be activated in 1-5 days.
// Satellite
// ClassDefinitonService Class 7The location is planned to be serviceable by Sky Muster (Satellite), but the infrastructure is not built or ready for use. You can’t connect yet, but you may be able to pre-sign. You’ll have to wait for NBN to announce the area is ready for service.Service Class 8The location is now serviceable by Satellite, but there’s no dish or NBN connection box installed at the property yet. You are able to order a service and an installation appointment can be made.Service Class 9The location is ready to connect with Satellite technology. The antenna and the NBN connection device are installed. You can order a service and it can be activated remotely.
// Fibre to the Node (FTTN)
// ClassDefinitonService Class 10The location is planned to be serviceable by copper for FTTN/FTTB but is not ready yet. Customers can pre-sign with us, but NBN are still in planning stages. infiNET customers can pre-sign, but you will have to wait until the area is ready for service.Service Class 11The location is ready to connect using copper technology, but additional works are needed. It’s best to make some arrangements prior to your installation for the lead-in cabling. You’re able to order a service and an installation appointment can be made.Service Class 12The location is ready to connect using copper technology, but additional works are needed. This class only requires jumper cabling to connect you to the network. You’re able to order a service and an installation appointment can be made if the line is not already active. The technician will not attend the home and will perform required work at the node.Service Class 13The location is ready to connect using copper technology, and all required cabling is installed and connected. You can order a service and it will be activated in 1-5 days.
// Hybrid Fibre Coaxial (HFC)
// ClassDefinitonService Class 20The location will be serviceable by Hybrid Fibre (HFC) in the future, but it’s not ready yet – NBN hasn’t finished connecting the local area. infiNET customers can pre-sign, but you will have to wait until the area is ready for service.Service Class 21The location is ready to connect using hybrid fibre technology, but additional works are needed to install lead-in cabling. You’re able to order a service and an installation appointment can be made.Service Class 22The location is ready to connect using HFC technology, but additional works are needed to install a network device and wall point. You’re able to order a service and an installation appointment can be made.Service Class 23The location is ready to connect using HFC technology, but additional works may be needed to install a network device. You’re able to order a service and an installation appointment can be made if a self-installation kit cannot be used.Service Class 24The location is ready to connect using HFC technology, and all required cabling/equipment has been installed. You can order a service and it will be activated in 1-5 days.* 
// *Sometimes, the network device (NTD) isn’t at the premises when you move in. If you cannot locate the device, please contact us as soon as possible to arrange a replacement unit.
// Fibre to the Curb (FTTC)
// ClassDefinitonService Class 30The location will be serviceable by copper and fibre (FTTC) in the future, but it’s not ready yet – NBN hasn’t finished connecting the local area. infiNET customers can pre-sign, but you will have to wait until the area is ready for service.Service Class 31The location is ready to connect using copper and fibre technologies, but additional works are needed to install lead-in cabling. You’re able to order a service and an installation appointment can be made.Service Class 32The location is ready to connect using copper and fibre technologies, but additional works are needed to connect the premises to a distribution point. You’re able to order a service and an installation appointment can be made.Service Class 33The location is ready to connect using FTTC, but additional works may be needed to install a network device. You’re able to order a service and an installation appointment can be made if a self-installation kit cannot be used.Service Class 34The location is ready to connect using FTTC, and all required cabling/equipment has been installed. You can order a service and it will be activated in 1-5 days.* 
// *Sometimes, the network device (NCD) isn’t at the premises when you move in. If you cannot locate the device, please contact us as soon as possible to arrange a replacement unit.
// OptiComm Service Classes
// Fibre to the Premises (FTTP)
// ClassDefinitonService Class 0The location will be serviceable by fibre (FTTP) in the future, but it’s not ready yet – OptiComm hasn’t finished connecting the local area.Service Class 1The location is serviceable by fibre, however no OptiComm equipment has been installed at the premises yet. You cannot place an order yet, but you may contact OptiComm directly to organise installation.*Service Class 2The location is ready to connect with fibre technology. The external devices have been installed at the premises, but no internal equipment is installed yet. You’re able to order a service and an installation appointment can be made and service then activated after payment clears**Service Class 3The location is fully installed and serviceable by fibre, with both the external and internal devices installed at the premises. You can order a service and it will be activated in 1-2 days.Service Class 5The location is fully installed and serviceable by fibre, with both the external and internal devices installed at the premises. However, a New Development Fee is payable to cover install costs. You can order a service and it will be activated after payment clears.***
// *To proceed with an order at a Service Class 1 address, you’ll need to get in touch with OptiComm directly (Click Here)
// **A New Connection Charge of $330.00 Inc. GST (Without MATV) or $550.00 Inc. GST (With MATV) will be charged when you sign up for a service at a property with a Service Class 2 assigned, for the first time only. Future connections at the address will not be charged this fee. MATV means multi-access television equipment connection is required. MATV is not available at all premises, Service Qualification (SQ) will confirm
// ***A New Devlopment Charge of $300.00 Inc. GST will be charged when you sign up for a service at a property with a Service Class 5 assigned, for the first time only. Future connections at the address will not be charged this fee.

// NBN FTTB Technology Explained
// Which NBN technology is available in my area?
// You can check your address using our “Check your Address” to see if NBN is available and what connection type is available?
// What is the FTTB NBN technology?
// Fibre to the Building (FTTB) – This connection is generally used when connecting an apartment block or similar types of buildings to the nbn™ access network. In this scenario, a fibre optic line is run to the fibre node in the building’s communications room, then the existing technology in the building (copper cabling) in used to connect to each apartment
// Connecting a Modem/Router to a FTTB service – The following diagram outlines how to connect the ADSL/VDSL modem/router to a FTTB service. You will require a NBN ready ADSL/VDSL router that has a DSL port.
// 1. Power Port – Connection port for the Power
// 2. DSL Port – Is the port to connect the telephone cable from the phone line socket
// 3. Phone Port/s – Is the port to connect a DECT phone into
// 4. Power Button – Button to turn the modem/router off/on
// 5. LAN Ports – To connect network, VoIP etc. devices into the router

// NBN FTTC Technology Explained
// Which NBN technology is available in my area?
// You can check your address using our “Check your Address” to see if NBN is available and what connection type is available?
// What is the FTTC NBN technology?
// Fibre to the Curb (FTTC) – connection is used in circumstances where fibre is extended close to your premises, connecting to a small Distribution Point Unit (DPU), generally located inside a pit on the street. From here, the existing copper network is connected to the fibre to form the final NBN™ connection into your premise. This will terminate into a NBN NCD (Network Connection Device).
// Connecting a Modem/Router to a FTTC service – The following diagram outlines how to connect the modem/router to a FTTC service. You will require a NBN ready modem/router.
// 1. Power Port – Connection port for the Power to the NBN NCD
// 2. Phone Line Socket & Wall socket Port – Is the socket within your premise where the telephone cable is terminated and connects to the NBN NCD
// 3. Gateway & WAN Port – Connect the NBN NCD to the WAN port on the router using an ethernet cable
// 4. Power Button – Button to turn the modem/router off/on

// NBN Fixed Wireless Technology Explained
// What is the NBN Fixed Wireless Technology?
// Fixed Wireless – An nbn™ Fixed Wireless connection utilises data transmitted over radio signals to connect a premises to the nbn™ network. This connection is typically used in circumstances where the distance between premises can be many kilometres. Data travels from a transmission tower located as far as 14 kilometres, to an nbn™ outdoor antenna that has been fitted to the premises by an approved nbn™ installer. Fixed Wireless connections also require an nbn™ connection box to be installed at the point where the cable from the nbn™ outdoor antenna enters your premises. This device requires power to operate and can only be installed by an nbn™ approved installer
// Connecting a Modem/Router to a HFC service – The following diagram outlines how to connect the modem/router to a NBN Fixed Wireless service. You will require a NBN ready modem/router.
// 1. Power Port – Connection port for the Power to the Modem/Router and NBN NCB
// 2. UNI-D Port 1 & WAN Port – Are the ports connecting the NCB to the Modem/Router
// 3. Power Button – Button to turn the modem/router off/on
// 4. Phone Port/s – Is the port to connect a DECT phone into

// NBN Satellite Technology Explained
// What is the NBN Satellite Technology?
// Satellite – The Sky Muster™ satellite service delivers the nbn™ network to homes and businesses in regional and remote Australia, via two state-of-the-art satellites. So, people across mainland Australia and Tasmania, and remote islands such as Norfolk Island, Christmas Island, Lord Howe Island and the Cocos (Keeling) Islands can now enjoy nbn™ powered plans through Sky Muster™ satellite providers.
// As well as the roof satellite dish installed on the home or business, Sky Muster™ satellite connections also require an nbn™ supplied modem to be installed at the point where the cable from the satellite dish enters the premises. This device requires power to operate and can only be installed by an nbn™ approved installer
// Connecting a Modem/Router to a HFC service – The following diagram outlines how to connect the modem/router to a NBN Satellite service. You will require a NBN ready modem/router.
// 1. Power Port – Connection port for the Power to the Modem/Router and NBN NCB
// 2. Satellite Cable Wall Socket/Port – Cable connecting the NCB to the wall socket
// 3. UNI-D Port 1 & WAN Port – Are the ports connecting the NCB to the Modem/Router
// 4. Power Button – Button to turn the modem/router off/on
// `;
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
• Check address/technology: Use InfiNET “Check your Address” tool or ask support
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