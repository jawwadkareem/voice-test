// // public/voice-widget.js
// // Voice widget: VAD -> record webm -> POST /api/voice (multipart: audio + sessionId + consent) -> show text + play audio
// (() => {
//   const START_THRESHOLD = 0.02;
//   const SILENCE_THRESHOLD = 0.015;
//   const SILENCE_TIMEOUT_MS = 650;
//   const POLL_INTERVAL_MS = 100;
//   const MIME_TYPE = "audio/webm";

//   const startBtn = document.getElementById("startBtn");
//   const stopBtn = document.getElementById("stopBtn");
//   const forceSend = document.getElementById("forceSend");
//   const statusEl = document.getElementById("status");
//   const transcriptEl = document.getElementById("transcript");
//   const player = document.getElementById("player");
//   const consentCheck = document.getElementById("consentCheck");
//   const clearSession = document.getElementById("clearSession");
//   const fieldsEl = document.getElementById("fields");

//   let audioContext, analyser, mediaStream, mediaRecorder, dataArray;
//   let monitoringInterval = null;
//   let audioChunks = [];
//   let speaking = false, silenceStart = null, running = false, playing = false;

//   startBtn.onclick = async () => { startBtn.disabled = true; stopBtn.disabled = false; await startAgent(); };
//   stopBtn.onclick = async () => { stopBtn.disabled = true; startBtn.disabled = false; await stopAgent(); };
//   forceSend.onclick = () => { if (mediaRecorder && mediaRecorder.state === "recording") { stopAndSend(); } };

//   clearSession.addEventListener("click", () => {
//     localStorage.removeItem("voiceAgent.sessionId");
//     fieldsEl.textContent = "";
//     transcriptEl.textContent = "Session reset.";
//   });

//   function getSessionId() {
//     let sid = localStorage.getItem("voiceAgent.sessionId");
//     if (!sid) {
//       sid = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
//       localStorage.setItem("voiceAgent.sessionId", sid);
//     }
//     return sid;
//   }

//   async function startAgent() {
//     try {
//       mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
//     } catch (e) {
//       alert("Microphone required: " + e.message);
//       startBtn.disabled = false; stopBtn.disabled = true;
//       return;
//     }
//     audioContext = new (window.AudioContext || window.webkitAudioContext)();
//     const src = audioContext.createMediaStreamSource(mediaStream);
//     analyser = audioContext.createAnalyser(); analyser.fftSize = 2048;
//     dataArray = new Float32Array(analyser.fftSize);
//     src.connect(analyser);

//     running = true;
//     statusEl.textContent = "listening...";
//     monitoringInterval = setInterval(monitor, POLL_INTERVAL_MS);
//     audioChunks = []; speaking = false; silenceStart = null;
//   }

//   async function stopAgent() {
//     running = false;
//     statusEl.textContent = "stopped";
//     if (monitoringInterval) { clearInterval(monitoringInterval); monitoringInterval = null; }
//     if (mediaRecorder && mediaRecorder.state !== "inactive") try { mediaRecorder.stop(); } catch(e) {}
//     if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
//     if (audioContext) try { await audioContext.close(); } catch(e) {} audioContext = null;
//   }

//   function monitor() {
//     if (!analyser) return;
//     analyser.getFloatTimeDomainData(dataArray);
//     let sum = 0;
//     for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
//     const rms = Math.sqrt(sum / dataArray.length);

//     if (playing) { speaking = false; silenceStart = null; return; }

//     if (!speaking && rms >= START_THRESHOLD) {
//       speaking = true; silenceStart = null; startRecording(); statusEl.textContent = "speaking...";
//       return;
//     }

//     if (speaking) {
//       if (rms < SILENCE_THRESHOLD) {
//         if (!silenceStart) silenceStart = Date.now();
//         else if (Date.now() - silenceStart >= SILENCE_TIMEOUT_MS) {
//           silenceStart = null; speaking = false; stopAndSend(); statusEl.textContent = "sending...";
//         }
//       } else {
//         silenceStart = null;
//       }
//     }
//   }

//   function startRecording() {
//     if (!mediaStream) return;
//     if (mediaRecorder && mediaRecorder.state !== "inactive") return;
//     audioChunks = [];
//     try {
//       mediaRecorder = new MediaRecorder(mediaStream, { mimeType: MIME_TYPE });
//     } catch (e) {
//       mediaRecorder = new MediaRecorder(mediaStream);
//     }
//     mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) audioChunks.push(e.data); };
//     mediaRecorder.start();
//   }

//   async function stopAndSend() {
//     if (!mediaRecorder) { statusEl.textContent = "listening..."; return; }
//     await new Promise((r) => { mediaRecorder.onstop = r; try { mediaRecorder.stop(); } catch(e) { r(); } });

//     const blob = new Blob(audioChunks, { type: MIME_TYPE });
//     if (blob.size < 300) { statusEl.textContent = "too short — continue..."; audioChunks=[]; mediaRecorder=null; return; }

//     // prepare form data
//     const sid = getSessionId();
//     const fd = new FormData();
//     fd.append("audio", blob, "recording.webm");
//     fd.append("sessionId", sid);
//     // pass consent as text field so server can use it too
//     fd.append("consent", consentCheck.checked ? "true" : "false");

//     try {
//       statusEl.textContent = "uploading...";
//       const resp = await fetch("/api/voice", { method: "POST", body: fd });
//       if (!resp.ok) {
//         const err = await resp.json().catch(()=>null);
//         statusEl.textContent = "server error";
//         console.error("Server error", err);
//         return;
//       }
//       const data = await resp.json();
//       if (data.sessionId) localStorage.setItem("voiceAgent.sessionId", data.sessionId);
//       transcriptEl.textContent = data.text || "(no text returned)";
//       if (data.collected) showCollected(data.collected);
//       if (data.audioBase64) {
//         playing = true;
//         await playBase64(data.audioBase64);
//         playing = false;
//       }
//       statusEl.textContent = "listening...";
//     } catch (e) {
//       console.error(e);
//       statusEl.textContent = "network error";
//     } finally {
//       audioChunks = []; mediaRecorder = null;
//       if (!monitoringInterval && running) monitoringInterval = setInterval(monitor, POLL_INTERVAL_MS);
//     }
//   }

//   function showCollected(obj) {
//     try {
//       const keys = Object.keys(obj || {});
//       if (!keys.length) { fieldsEl.textContent = ""; return; }
//       fieldsEl.textContent = "Collected: " + keys.map(k => `${k}: ${obj[k]}`).join(" | ");
//     } catch (e) { fieldsEl.textContent = ""; }
//   }

//   function playBase64(b64) {
//     return new Promise((resolve) => {
//       try {
//         const bytes = atob(b64);
//         const len = bytes.length;
//         const arr = new Uint8Array(len);
//         for (let i = 0; i < len; i++) arr[i] = bytes.charCodeAt(i);
//         const blob = new Blob([arr.buffer], { type: "audio/mpeg" });
//         const url = URL.createObjectURL(blob);
//         player.src = url;
//         player.onended = () => { URL.revokeObjectURL(url); resolve(); };
//         player.onerror = () => { URL.revokeObjectURL(url); resolve(); };
//         player.play().catch(() => resolve());
//       } catch (e) { resolve(); }
//     });
//   }

//   window.addEventListener("beforeunload", async () => { await stopAgent(); });

// })();
// public/voice-widget.js
// (() => {
//   const START_THRESHOLD = 0.015;
//   const SILENCE_THRESHOLD = 0.012;
//   const SILENCE_TIMEOUT_MS = 450;
//   const POLL_INTERVAL_MS = 100;
//   const MIME_TYPE = "audio/webm";

//   const startBtn = document.getElementById("startBtn");
//   const stopBtn = document.getElementById("stopBtn");
//   const forceSend = document.getElementById("forceSend");
//   const statusEl = document.getElementById("status");
//   const transcriptEl = document.getElementById("transcript");
//   const player = document.getElementById("player");
//   const consentCheck = document.getElementById("consentCheck");
//   const clearSession = document.getElementById("clearSession");
//   const fieldsEl = document.getElementById("fields");

//   let audioContext, analyser, mediaStream, mediaRecorder, dataArray;
//   let monitoringInterval = null;
//   let audioChunks = [];
//   let speaking = false, silenceStart = null, running = false, playing = false;

//   startBtn.onclick = async () => { startBtn.disabled = true; stopBtn.disabled = false; await startAgent(); };
//   stopBtn.onclick = async () => { stopBtn.disabled = true; startBtn.disabled = false; await stopAgent(); };
//   forceSend.onclick = () => { if (mediaRecorder && mediaRecorder.state === "recording") { stopAndSend(); } };

//   clearSession.addEventListener("click", () => {
//     localStorage.removeItem("voiceAgent.sessionId");
//     fieldsEl.textContent = "";
//     transcriptEl.textContent = "Session reset.";
//   });

//   function getSessionId() {
//     let sid = localStorage.getItem("voiceAgent.sessionId");
//     if (!sid) {
//       sid = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
//       localStorage.setItem("voiceAgent.sessionId", sid);
//     }
//     return sid;
//   }

//   async function startAgent() {
//     try {
//       mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
//     } catch (e) {
//       alert("Microphone required: " + e.message);
//       startBtn.disabled = false; stopBtn.disabled = true;
//       return;
//     }
//     audioContext = new (window.AudioContext || window.webkitAudioContext)();
//     const src = audioContext.createMediaStreamSource(mediaStream);
//     analyser = audioContext.createAnalyser(); analyser.fftSize = 2048;
//     dataArray = new Float32Array(analyser.fftSize);
//     src.connect(analyser);

//     running = true;
//     statusEl.textContent = "listening...";
//     monitoringInterval = setInterval(monitor, POLL_INTERVAL_MS);
//     audioChunks = []; speaking = false; silenceStart = null;
//   }

//   async function stopAgent() {
//     running = false;
//     statusEl.textContent = "stopped";
//     if (monitoringInterval) { clearInterval(monitoringInterval); monitoringInterval = null; }
//     if (mediaRecorder && mediaRecorder.state !== "inactive") try { mediaRecorder.stop(); } catch(e) {}
//     if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
//     if (audioContext) try { await audioContext.close(); } catch(e) {} audioContext = null;
//   }

//   function monitor() {
//     if (!analyser) return;
//     analyser.getFloatTimeDomainData(dataArray);
//     let sum = 0;
//     for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
//     const rms = Math.sqrt(sum / dataArray.length);

//     if (playing) { speaking = false; silenceStart = null; return; }

//     if (!speaking && rms >= START_THRESHOLD) {
//       speaking = true; silenceStart = null; startRecording(); statusEl.textContent = "speaking...";
//       return;
//     }

//     if (speaking) {
//       if (rms < SILENCE_THRESHOLD) {
//         if (!silenceStart) silenceStart = Date.now();
//         else if (Date.now() - silenceStart >= SILENCE_TIMEOUT_MS) {
//           silenceStart = null; speaking = false; stopAndSend(); statusEl.textContent = "sending...";
//         }
//       } else {
//         silenceStart = null;
//       }
//     }
//   }

//   function startRecording() {
//     if (!mediaStream) return;
//     if (mediaRecorder && mediaRecorder.state !== "inactive") return;
//     audioChunks = [];
//     try {
//       mediaRecorder = new MediaRecorder(mediaStream, { mimeType: MIME_TYPE });
//     } catch (e) {
//       mediaRecorder = new MediaRecorder(mediaStream);
//     }
//     mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) audioChunks.push(e.data); };
//     mediaRecorder.start();
//   }

//   async function stopAndSend() {
//     if (!mediaRecorder) { statusEl.textContent = "listening..."; return; }
//     await new Promise((r) => { mediaRecorder.onstop = r; try { mediaRecorder.stop(); } catch(e) { r(); } });

//     const blob = new Blob(audioChunks, { type: MIME_TYPE });
//     if (blob.size < 300) { statusEl.textContent = "too short — continue..."; audioChunks=[]; mediaRecorder=null; return; }

//     const sid = getSessionId();
//     const fd = new FormData();
//     fd.append("audio", blob, "recording.webm");
//     fd.append("sessionId", sid);
//     fd.append("consent", consentCheck.checked ? "true" : "false");

//     try {
//       statusEl.textContent = "uploading...";
//       const resp = await fetch("/api/voice", { method: "POST", body: fd });
//       if (!resp.ok) {
//         const err = await resp.json().catch(()=>null);
//         statusEl.textContent = "server error";
//         console.error("Server error", err);
//         return;
//       }
//       const data = await resp.json();
//       if (data.sessionId) localStorage.setItem("voiceAgent.sessionId", data.sessionId);
//       transcriptEl.textContent = data.text || "(no text returned)";
//       if (data.collected) showCollected(data.collected);
//       if (data.audioBase64) {
//         playing = true;
//         await playBase64(data.audioBase64);
//         playing = false;
//       }
//       statusEl.textContent = "listening...";
//     } catch (e) {
//       console.error(e);
//       statusEl.textContent = "network error";
//     } finally {
//       audioChunks = []; mediaRecorder = null;
//       if (!monitoringInterval && running) monitoringInterval = setInterval(monitor, POLL_INTERVAL_MS);
//     }
//   }

//   function showCollected(obj) {
//     try {
//       const keys = Object.keys(obj || {});
//       if (!keys.length) { fieldsEl.textContent = ""; return; }
//       fieldsEl.textContent = "Collected: " + keys.map(k => `${k}: ${obj[k]}`).join(" | ");
//     } catch (e) { fieldsEl.textContent = ""; }
//   }

//   function playBase64(b64) {
//     return new Promise((resolve) => {
//       try {
//         const bytes = atob(b64);
//         const len = bytes.length;
//         const arr = new Uint8Array(len);
//         for (let i = 0; i < len; i++) arr[i] = bytes.charCodeAt(i);
//         const blob = new Blob([arr.buffer], { type: "audio/mpeg" });
//         const url = URL.createObjectURL(blob);
//         player.src = url;
//         player.onended = () => { URL.revokeObjectURL(url); resolve(); };
//         player.onerror = () => { URL.revokeObjectURL(url); resolve(); };
//         player.play().catch(() => resolve());
//       } catch (e) { resolve(); }
//     });
//   }

//   async function initSession() {
//     try {
//       const resp = await fetch("/api/chat/init", { method: "POST" });
//       if (!resp.ok) return;
//       const data = await resp.json();
//       if (data.sessionId) localStorage.setItem("voiceAgent.sessionId", data.sessionId);
//       transcriptEl.textContent = data.text || "Welcome.";
//       if (data.audioBase64) {
//         playing = true;
//         await playBase64(data.audioBase64);
//         playing = false;
//       }
//     } catch (e) {
//       console.warn("init session error", e);
//     }
//   }

//   window.addEventListener("load", () => {
//     initSession();
//   });

//   window.addEventListener("beforeunload", async () => { await stopAgent(); });
// })();
/* Updated voice-widget.js
   - Removed consent checkbox
   - Shows Start / Stop label visibly
   - Mic morphs to stop icon when active
   - Responsive tweaks integrated via CSS
   - Keeps endpoints: /api/voice and /api/chat/init
*/

(() => {
  const START_THRESHOLD = 0.015;
  const SILENCE_THRESHOLD = 0.012;
  const SILENCE_TIMEOUT_MS = 450;
  const POLL_INTERVAL_MS = 100;
  const MIME_TYPE = "audio/webm";

  // UI refs
  const micBtn = document.getElementById("micBtn");
  const forceSendBtn = document.getElementById("forceSendBtn");
  const resetBtn = document.getElementById("resetBtn");
  const stopBtn = document.getElementById("stopBtn");
  const statusDot = document.getElementById("statusDot");
  const statusLabel = document.getElementById("statusLabel");
  const micLabel = document.getElementById("micLabel");
  const micCore = document.getElementById("micCore");
  const micIcon = document.getElementById("micIcon");
  const stopIcon = document.getElementById("stopIcon");
  const transcriptEl = document.getElementById("transcript");
  const player = document.getElementById("player");
  const fieldsEl = document.getElementById("fields");
  const animatedRing = document.getElementById("animatedRing");
  const waveCanvas = document.getElementById("waveCanvas");
  const waveCtx = waveCanvas.getContext('2d');

  let audioContext, analyser, mediaStream, mediaRecorder, dataArray;
  let monitoringInterval = null;
  let audioChunks = [];
  let speaking = false, silenceStart = null, running = false, playing = false;

  let waveLevel = 0;

  function getSessionId() {
    let sid = localStorage.getItem("voiceAgent.sessionId");
    if (!sid) {
      sid = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
      localStorage.setItem("voiceAgent.sessionId", sid);
    }
    return sid;
  }

  function setStatus(mode, label) {
    statusLabel.textContent = label || mode;
    statusDot.className = 'status-dot ' + (mode === 'idle' ? '' : mode);
    if (mode === 'speaking') {
      animatedRing.style.transform = 'scale(1.06)';
      animatedRing.style.opacity = '0.95';
      micBtn.classList.add('speaking');
    } else if (mode === 'listening') {
      animatedRing.style.transform = 'scale(0.98)';
      animatedRing.style.opacity = '0.9';
      micBtn.classList.remove('speaking');
    } else {
      animatedRing.style.opacity = '0.12';
      animatedRing.style.transform = 'scale(0.92)';
      micBtn.classList.remove('speaking');
    }
  }

  // Wave drawing
  function drawWave() {
    const w = waveCanvas.width;
    const h = waveCanvas.height;
    waveCtx.clearRect(0,0,w,h);

    // subtle background
    const g = waveCtx.createLinearGradient(0,0,w,0);
    g.addColorStop(0, 'rgba(255,255,255,0.012)');
    g.addColorStop(1, 'rgba(255,255,255,0.01)');
    waveCtx.fillStyle = g;
    waveCtx.fillRect(0,0,w,h);

    // waveform
    waveCtx.beginPath();
    const amplitude = Math.max(0.01, Math.min(0.9, waveLevel * 1.3));
    const centerY = h / 2;
    const segments = 120;
    for (let i = 0; i <= segments; i++) {
      const x = (i / segments) * w;
      const theta = i / segments * Math.PI;
      const y = centerY + Math.sin(theta * 2 + (Date.now() / 300)) * amplitude * centerY * (0.5 + 0.5 * Math.cos(theta));
      if (i === 0) waveCtx.moveTo(x, y);
      else waveCtx.lineTo(x, y);
    }
    waveCtx.lineWidth = 2.4;
    waveCtx.strokeStyle = 'rgba(124,58,237,0.95)';
    waveCtx.shadowBlur = 12;
    waveCtx.shadowColor = 'rgba(124,58,237,0.22)';
    waveCtx.stroke();
    waveCtx.shadowBlur = 0;

    requestAnimationFrame(drawWave);
  }

  function monitor() {
    if (!analyser || !dataArray) return;
    analyser.getFloatTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
    const rms = Math.sqrt(sum / dataArray.length);
    waveLevel = rms;

    if (playing) { speaking = false; silenceStart = null; return; }

    if (!speaking && rms >= START_THRESHOLD) {
      speaking = true; silenceStart = null; startRecording(); setStatus('speaking','speaking…'); updateLabel('Stop');
      return;
    }

    if (speaking) {
      if (rms < SILENCE_THRESHOLD) {
        if (!silenceStart) silenceStart = Date.now();
        else if (Date.now() - silenceStart >= SILENCE_TIMEOUT_MS) {
          silenceStart = null; speaking = false; stopAndSend(); setStatus('uploading','sending…'); updateLabel('Start');
        }
      } else {
        silenceStart = null;
      }
    }
  }

  async function startAgent() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      alert("Microphone required: " + (e && e.message ? e.message : e));
      return;
    }
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyser(); analyser.fftSize = 2048;
    dataArray = new Float32Array(analyser.fftSize);
    src.connect(analyser);

    running = true;
    setStatus('listening','listening');
    if (monitoringInterval) clearInterval(monitoringInterval);
    monitoringInterval = setInterval(monitor, POLL_INTERVAL_MS);

    // show stop icon
    micBtn.setAttribute('aria-pressed','true');
    micIcon.style.opacity = 0;
    stopIcon.style.opacity = 1;
    updateLabel('Stop');
  }

  async function stopAgent() {
    running = false;
    setStatus('idle','idle');
    if (monitoringInterval) { clearInterval(monitoringInterval); monitoringInterval = null; }
    if (mediaRecorder && mediaRecorder.state !== "inactive") try { mediaRecorder.stop(); } catch(e) {}
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    if (audioContext) try { await audioContext.close(); } catch(e) {} audioContext = null;

    // show mic icon
    micBtn.setAttribute('aria-pressed','false');
    micIcon.style.opacity = 1;
    stopIcon.style.opacity = 0;
    updateLabel('Start');
  }

  function startRecording() {
    if (!mediaStream) return;
    if (mediaRecorder && mediaRecorder.state !== "inactive") return;
    audioChunks = [];
    try { mediaRecorder = new MediaRecorder(mediaStream, { mimeType: MIME_TYPE }); }
    catch (e) { mediaRecorder = new MediaRecorder(mediaStream); }
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.start();
  }

  async function stopAndSend() {
    if (!mediaRecorder) { setStatus('listening','listening'); return; }
    await new Promise((r) => { mediaRecorder.onstop = r; try { mediaRecorder.stop(); } catch(e) { r(); } });

    const blob = new Blob(audioChunks, { type: MIME_TYPE });
    if (blob.size < 300) { setStatus('listening','too short — continue…'); audioChunks=[]; mediaRecorder=null; return; }

    const sid = getSessionId();
    const fd = new FormData();
    fd.append("audio", blob, "recording.webm");
    fd.append("sessionId", sid);
    // consent removed from UI — send implicit consent = true
    fd.append("consent", "true");

    try {
      setStatus('uploading','uploading…');
      const resp = await fetch("/api/voice", { method: "POST", body: fd });
      if (!resp.ok) {
        const err = await resp.json().catch(()=>null);
        setStatus('error','server error');
        console.error("Server error", err);
        transcriptEl.textContent = err && err.message ? err.message : '(server error)';
        return;
      }
      const data = await resp.json();
      if (data.sessionId) localStorage.setItem("voiceAgent.sessionId", data.sessionId);
      transcriptEl.textContent = data.text || "(no text returned)";
      if (data.collected) showCollected(data.collected);
      if (data.audioBase64) {
        playing = true;
        await playBase64(data.audioBase64);
        playing = false;
      }
      setStatus('listening','listening');
    } catch (e) {
      console.error(e);
      setStatus('error','network error');
      transcriptEl.textContent = "network error";
    } finally {
      audioChunks = []; mediaRecorder = null;
      if (!monitoringInterval && running) monitoringInterval = setInterval(monitor, POLL_INTERVAL_MS);
    }
  }

  function showCollected(obj) {
    try {
      const keys = Object.keys(obj || {});
      if (!keys.length) { fieldsEl.textContent = ""; return; }
      fieldsEl.textContent = "Collected: " + keys.map(k => `${k}: ${obj[k]}`).join(" | ");
    } catch (e) { fieldsEl.textContent = ""; }
  }

  function playBase64(b64) {
    return new Promise((resolve) => {
      try {
        const bytes = atob(b64);
        const len = bytes.length;
        const arr = new Uint8Array(len);
        for (let i = 0; i < len; i++) arr[i] = bytes.charCodeAt(i);
        const blob = new Blob([arr.buffer], { type: "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        player.src = url;
        player.onended = () => { URL.revokeObjectURL(url); resolve(); };
        player.onerror = () => { URL.revokeObjectURL(url); resolve(); };
        player.play().catch(() => resolve());
      } catch (e) { resolve(); }
    });
  }

  async function initSession() {
    try {
      const resp = await fetch("/api/chat/init", { method: "POST" });
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.sessionId) localStorage.setItem("voiceAgent.sessionId", data.sessionId);
      transcriptEl.textContent = data.text || "Welcome.";
      if (data.audioBase64) {
        playing = true;
        await playBase64(data.audioBase64);
        playing = false;
      }
    } catch (e) {
      console.warn("init session error", e);
    }
  }

  // UI updates
  function updateLabel(text) {
    micLabel.textContent = text;
  }

  // events
  micBtn.addEventListener('click', async () => {
    if (!running) {
      await startAgent();
    } else {
      await stopAgent();
    }
  });

  forceSendBtn.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === "recording") { stopAndSend(); }
  });

  stopBtn.addEventListener('click', async () => { await stopAgent(); });

  resetBtn.addEventListener('click', () => {
    localStorage.removeItem("voiceAgent.sessionId");
    fieldsEl.textContent = "";
    transcriptEl.textContent = "Session reset.";
    setStatus('idle','reset');
    stopIcon.style.opacity = 0;
    micIcon.style.opacity = 1;
    updateLabel('Start');
  });

  // waveform loop
  requestAnimationFrame(drawWave);

  window.addEventListener("load", () => {
    initSession();
    setStatus('idle','idle');
    updateLabel('Start');
    // ensure icons initial state
    micIcon.style.opacity = 1;
    stopIcon.style.opacity = 0;
  });

  window.addEventListener("beforeunload", async () => { await stopAgent(); });
})();