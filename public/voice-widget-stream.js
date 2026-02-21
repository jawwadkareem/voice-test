// public/voice-widget-stream.js
(() => {
  const WS_URL = (location.host.includes("localhost") ? "ws://localhost:3000" : `wss://${location.host.split(":")[0]}:4000`);
  const startBtn = document.getElementById("start");
  const stopBtn = document.getElementById("stop");
  const flushBtn = document.getElementById("flush");
  const statusEl = document.getElementById("status");
  const transcriptEl = document.getElementById("transcript");
  const player = document.getElementById("player");

  let ws = null;
  let mediaStream = null;
  let mediaRecorder = null;
  let recording = false;

  function connectWS() {
    ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      statusEl.textContent = "ws connected";
      // send init with session id and consent (if you track it)
      ws.send(JSON.stringify({ type: "init", sessionId: localStorage.getItem("voiceAgent.sessionId") || null, consent: true }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        // JSON control
        let obj;
        try { obj = JSON.parse(ev.data); } catch(e) { return; }
        if (obj.type === "server_session") {
          // server assigned session id; store if you want
          localStorage.setItem("voiceAgent.sessionId", obj.sid);
        } else if (obj.type === "partial_transcript") {
          transcriptEl.textContent = obj.text;
        } else if (obj.type === "assistant_text") {
          // also show assistant text
          transcriptEl.textContent = "Assistant: " + obj.text;
        }
      } else {
        // binary with header + mp3 bytes (server format)
        const arr = new Uint8Array(ev.data);
        // find newline separator
        const nl = arr.indexOf(10); // '\n'
        if (nl > 0) {
          const header = new TextDecoder().decode(arr.slice(0, nl));
          let meta = {};
          try { meta = JSON.parse(header); } catch(e) {}
          const audioBytes = arr.slice(nl + 1);
          // create blob and play
          const blob = new Blob([audioBytes], { type: meta.format === "mp3" ? "audio/mpeg" : "audio/ogg" });
          const url = URL.createObjectURL(blob);
          player.src = url;
          player.onended = () => URL.revokeObjectURL(url);
          player.play().catch(()=>{});
        }
      }
    };
    ws.onclose = () => statusEl.textContent = "ws closed";
    ws.onerror = (e) => console.error("ws error", e);
  }

  async function start() {
    if (!ws || ws.readyState !== WebSocket.OPEN) connectWS();
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) { alert("Mic permission required"); return; }

    // small timeslice: send chunks every 250ms to reduce latency
    const timeslice = 250;
    try {
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: "audio/webm" });
    } catch (e) {
      mediaRecorder = new MediaRecorder(mediaStream);
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0 && ws && ws.readyState === WebSocket.OPEN) {
        // send raw binary chunk
        e.data.arrayBuffer().then(buf => ws.send(buf));
      }
    };

    mediaRecorder.start(timeslice);
    recording = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusEl.textContent = "recording...";
  }

  async function stop() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
    recording = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    statusEl.textContent = "stopped";
  }

  flushBtn.addEventListener("click", () => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "flush" }));
  });

  startBtn.addEventListener("click", start);
  stopBtn.addEventListener("click", stop);

  // connect early
  connectWS();
})();