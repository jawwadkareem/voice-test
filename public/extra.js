(() => {
  // config
  const TARGET_RATE = 24000;     // server expects/produces 24k PCM16 (as in your widget)
  const CHUNK_SIZE = 1024;       // approx buffer size for encoding; tune as needed
  const PORT = 3003;             // server port (match your server)
  const HOST = location.hostname || 'localhost';

  // UI refs
  const micBtn = document.getElementById("micBtn");
  const forceSendBtn = document.getElementById("forceSendBtn");
  const resetBtn = document.getElementById("resetBtn");
  const stopBtn = document.getElementById("stopBtn");
  const statusDot = document.getElementById("statusDot");
  const statusLabel = document.getElementById("statusLabel");
  const micLabel = document.getElementById("micLabel");
  const micIcon = document.getElementById("micIcon");
  const stopIcon = document.getElementById("stopIcon");
  const transcriptEl = document.getElementById("transcript");
  const fieldsEl = document.getElementById("fields");
  const animatedRing = document.getElementById("animatedRing");
  const waveCanvas = document.getElementById("waveCanvas");
  const waveCtx = waveCanvas.getContext('2d');

  let audioContext, playbackContext, mediaStream;
  let ws;
  let running = false;
  let waveLevel = 0;
  let audioQueue = [];
  let currentSource = null;

  // helpers
  function setStatus(mode, label) {
    statusLabel.textContent = label || mode;
    statusDot.className = 'status-dot ' + (mode === 'idle' ? '' : mode);
    if (mode === 'speaking') { micBtn.classList.add('speaking'); }
    else { micBtn.classList.remove('speaking'); }
  }

  function drawWave() {
    const w = waveCanvas.width, h = waveCanvas.height;
    waveCtx.clearRect(0,0,w,h);
    // background
    const g = waveCtx.createLinearGradient(0,0,w,0);
    g.addColorStop(0, 'rgba(255,255,255,0.012)');
    g.addColorStop(1, 'rgba(255,255,255,0.01)');
    waveCtx.fillStyle = g;
    waveCtx.fillRect(0,0,w,h);
    // waveform
    waveCtx.beginPath();
    const amplitude = Math.max(0.01, Math.min(0.9, waveLevel * 1.4));
    const centerY = h/2;
    const segments = 120;
    for (let i=0;i<=segments;i++){
      const x = (i/segments) * w;
      const theta = i/segments * Math.PI;
      const y = centerY + Math.sin(theta*2 + (Date.now()/300)) * amplitude * centerY * (0.5 + 0.5 * Math.cos(theta));
      if (i===0) waveCtx.moveTo(x,y); else waveCtx.lineTo(x,y);
    }
    waveCtx.lineWidth = 2.4;
    waveCtx.strokeStyle = 'rgba(124,58,237,0.95)';
    waveCtx.shadowBlur = 12;
    waveCtx.shadowColor = 'rgba(124,58,237,0.22)';
    waveCtx.stroke();
    waveCtx.shadowBlur = 0;
    requestAnimationFrame(drawWave);
  }

  // ---------- base64 helpers (chunked) ----------
  function uint8ToBase64(uint8) {
    const CHUNK = 0x8000;
    let result = '';
    for (let i=0; i < uint8.length; i += CHUNK) {
      result += String.fromCharCode.apply(null, uint8.subarray(i, i + CHUNK));
    }
    return btoa(result);
  }

  function base64ToUint8(base64) {
    const bin = atob(base64);
    const len = bin.length;
    const out = new Uint8Array(len);
    for (let i=0;i<len;i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function floatTo16BitPCM(float32Array) {
    const int16 = new Int16Array(float32Array.length);
    for (let i=0;i<float32Array.length;i++){
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
  }

  // resample linear interpolation (simple)
  function resample(input, sourceRate, targetRate = TARGET_RATE) {
    if (!input || sourceRate === targetRate) return input;
    const ratio = sourceRate / targetRate;
    const length = Math.round(input.length / ratio);
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const idx = i * ratio;
      const low = Math.floor(idx);
      const high = Math.min(low + 1, input.length - 1);
      const frac = idx - low;
      out[i] = input[low] + frac * (input[high] - input[low]);
    }
    return out;
  }

  // ---------- playback of PCM16 base64 from server ----------
  function playAudioDelta(base64) {
    // base64 -> Uint8Array -> Int16Array -> Float32Array -> queue
    try {
      const bytes = base64ToUint8(base64);
      // bytes length should be multiple of 2 for Int16
      const dv = new DataView(bytes.buffer);
      const len = bytes.length / 2;
      const floatBuf = new Float32Array(len);
      for (let i=0;i<len;i++){
        const int = dv.getInt16(i*2, true);
        floatBuf[i] = int / 32768.0;
      }
      audioQueue.push(floatBuf);
      playNext();
    } catch (e) {
      console.warn("playAudioDelta decode failed", e);
    }
  }

  function playNext() {
    if (!audioQueue.length || currentSource) return;
    if (!playbackContext) playbackContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TARGET_RATE });
    const buf = audioQueue.shift();
    const audioBuffer = playbackContext.createBuffer(1, buf.length, TARGET_RATE);
    audioBuffer.copyToChannel(buf, 0);
    currentSource = playbackContext.createBufferSource();
    currentSource.buffer = audioBuffer;
    currentSource.connect(playbackContext.destination);
    currentSource.onended = () => {
      currentSource = null;
      playNext();
    };
    currentSource.start();
  }

  // ---------- WebSocket connection ----------
  function connectWS() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${HOST}:${PORT}`;
    console.log("connecting to", url);
    ws = new WebSocket(url);
    ws.onopen = () => {
      console.log("ws open");
      setStatus('listening','connected');
    };
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'session_id') {
          localStorage.setItem("voiceAgent.sessionId", data.sessionId);
        } else if (data.type === 'audio_delta') {
          playAudioDelta(data.delta);
          setStatus('speaking','assistant speaking');
        } else if (data.type === 'audio_done') {
          setStatus('listening','listening');
        } else if (data.type === 'transcript_delta') {
          transcriptEl.textContent += data.delta;
        } else if (data.type === 'transcript_done') {
          transcriptEl.textContent = '';
        } else if (data.type === 'collected') {
          fieldsEl.textContent = JSON.stringify(data.data);
        } else if (data.type === 'error') {
          console.warn("server error:", data);
          setStatus('error', data.error || 'error');
        }
      } catch (e) { console.warn("ws message parse failed", e); }
    };
    ws.onclose = () => {
      console.log("ws closed");
      setStatus('idle','disconnected');
    };
    ws.onerror = (e) => {
      console.error("ws error", e);
      setStatus('error','ws error');
    };
  }

  // ---------- Audio capture & streaming ----------
  async function startAgent() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioContext.createMediaStreamSource(mediaStream);

      // try AudioWorklet, fallback to ScriptProcessorNode
      let processorNode;
      const workletCode = `
class AudioProcessor extends AudioWorkletProcessor {
  constructor(){ super(); }
  process(inputs) {
    const input = inputs[0][0];
    if (input) this.port.postMessage(input);
    return true;
  }
}
registerProcessor('audio-processor', AudioProcessor);
`;
      try {
        const blob = new Blob([workletCode], { type: 'application/javascript' });
        await audioContext.audioWorklet.addModule(URL.createObjectURL(blob));
        processorNode = new AudioWorkletNode(audioContext, 'audio-processor');
      } catch (e) {
        // fallback
        const bufSize = 4096;
        processorNode = audioContext.createScriptProcessor(bufSize, 1, 1);
        processorNode.onaudioprocess = (ev) => {
          const input = ev.inputBuffer.getChannelData(0);
          if (processorNode.port && processorNode.port.postMessage) processorNode.port.postMessage(input);
        };
        // create a port-like wrapper for consistent handling
        processorNode.port = {
          postMessage: (d) => { processorNode._last = d; },
          onmessage: null
        };
      }

      // common handler for messages from worklet or fallback
      if (processorNode.port) {
        processorNode.port.onmessage = (e) => {
          if (!running || !ws || ws.readyState !== WebSocket.OPEN) return;
          const input = e.data;
          // compute volume for wave
          let sum = 0;
          for (let i=0;i<input.length;i++) sum += input[i]*input[i];
          waveLevel = Math.sqrt(sum / input.length);
          // resample from audioContext.sampleRate to TARGET_RATE
          const resampled = resample(input, audioContext.sampleRate, TARGET_RATE);
          const pcm16 = floatTo16BitPCM(resampled);
          const bytes = new Uint8Array(pcm16.buffer);
          const base64 = uint8ToBase64(bytes);
          try { ws.send(JSON.stringify({ type: 'input_audio', data: base64 })); } catch (err) { /* ignore */ }
        };
      }

      src.connect(processorNode);
      processorNode.connect(audioContext.destination); // avoid GC sometimes; no audible output due to low gain

      running = true;
      setStatus('listening','listening');
      micBtn.setAttribute('aria-pressed','true');
      micIcon.style.opacity = 0;
      stopIcon.style.opacity = 1;
      updateLabel('Stop');

      connectWS();
      playbackContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TARGET_RATE });
    } catch (e) {
      alert("Microphone required: " + (e.message || e));
      console.error(e);
    }
  }

  async function stopAgent() {
    running = false;
    setStatus('idle','idle');
    try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch(e){}
    try { if (audioContext) await audioContext.close(); } catch(e){}
    try { if (playbackContext) await playbackContext.close(); } catch(e){}
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    micBtn.setAttribute('aria-pressed','false');
    micIcon.style.opacity = 1;
    stopIcon.style.opacity = 0;
    updateLabel('Start');
  }

  // send commit (finalize utterance)
  function commit() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'commit' }));
    }
  }

  // small helpers
  function updateLabel(text) { micLabel.textContent = text; }

  // UI events
  micBtn.addEventListener('click', async () => {
    if (!running) await startAgent();
    else await stopAgent();
  });
  forceSendBtn.addEventListener('click', () => commit());
  stopBtn.addEventListener('click', async () => await stopAgent());
  resetBtn.addEventListener('click', () => {
    localStorage.removeItem("voiceAgent.sessionId");
    fieldsEl.textContent = "";
    transcriptEl.textContent = "Session reset.";
    setStatus('idle','reset');
    stopIcon.style.opacity = 0; micIcon.style.opacity = 1;
    updateLabel('Start');
    if (ws) ws.close();
  });

  // initial UI state & rendering loop
  requestAnimationFrame(drawWave);
  window.addEventListener("load", () => {
    setStatus('idle','idle');
    updateLabel('Start');
    micIcon.style.opacity = 1;
    stopIcon.style.opacity = 0;
  });

  window.addEventListener("beforeunload", async () => { await stopAgent(); });
})();