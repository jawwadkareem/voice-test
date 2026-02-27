// public/webrtc-client.js
(() => {
  const WS_PROTO = (location.protocol === "https:") ? "wss:" : "ws:";
  const WS_URL = `${WS_PROTO}//${location.host}`;

  const iceServers = [{ urls: window.__STUN_URL || "stun:stun.l.google.com:19302" }];
  if (window.__TURN_URL) {
    iceServers.push({
      urls: window.__TURN_URL,
      username: window.__TURN_USER || undefined,
      credential: window.__TURN_PASS || undefined
    });
  }

  function makePeer(onTrack, onState) {
    const pc = new RTCPeerConnection({ iceServers });
    pc.ontrack = (ev) => { if (onTrack) onTrack(ev); };
    pc.oniceconnectionstatechange = () => {
      if (onState) onState(pc.iceConnectionState);
    };
    return pc;
  }

  async function getMicrophoneStream() {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }});
  }

  async function createWebSocket(onOpen, onMessage, onClose) {
    const ws = new WebSocket(WS_URL);
    ws.addEventListener("open", onOpen);
    ws.addEventListener("message", (e) => onMessage(e && e.data ? JSON.parse(e.data) : null));
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onClose);
    return ws;
  }

  async function init(opts = {}) {
    const onState = opts.onState || (() => {});
    const remoteAudioEl = opts.remoteAudioEl || null;
    const autoGetMic = (opts.autoGetMic === false) ? false : true;

    let socket = null;
    let pc = null;
    let localStream = null;
    let joinedSession = null;
    let isCaller = false;

    function sendWS(obj) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(obj));
    }

    async function ensureSocket() {
      if (socket && socket.readyState === WebSocket.OPEN) return;
      socket = await createWebSocket(
        () => onState("ws-open"),
        async (msg) => {
          if (!msg) return;
          const { type, sessionId, sdp, candidate, metadata } = msg;

          if (type === "peer-joined") {
            onState("peer-joined");
            return;
          }

          if (type === "offer") {
            await ensurePC();
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendWS({ type: "answer", sessionId, sdp: pc.localDescription, metadata: { from: "answerer" } });
            return;
          }

          if (type === "answer") {
            if (!pc) return;
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            return;
          }

          if (type === "candidate") {
            if (!pc) return;
            try {
              await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
              console.warn("addIceCandidate error", e);
            }
            return;
          }
        },
        () => {
          onState("ws-closed");
        }
      );
    }

    async function ensurePC() {
      if (pc) return;
      pc = makePeer((ev) => {
        const stream = ev.streams && ev.streams[0];
        if (stream && remoteAudioEl) {
          remoteAudioEl.srcObject = stream;
          remoteAudioEl.play().catch(()=>{});
        }
      }, (state) => {
        onState("pc:" + state);
      });

      pc.onicecandidate = (e) => {
        if (e.candidate && joinedSession) {
          sendWS({ type: "candidate", sessionId: joinedSession, candidate: e.candidate });
        }
      };

      if (!localStream && autoGetMic) {
        try {
          localStream = await getMicrophoneStream();
        } catch (e) {
          console.error("getUserMedia failed", e);
          throw e;
        }
      }
      if (localStream) {
        for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
      }
    }

    async function join(sessionId, opts = {}) {
      joinedSession = sessionId;
      isCaller = !!opts.isCaller;
      await ensureSocket();
      sendWS({ type: "join", sessionId, metadata: opts.metadata || {} });
      await ensurePC();

      if (isCaller) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendWS({ type: "offer", sessionId, sdp: pc.localDescription, metadata: { from: "caller" } });
      }
      onState("joined");
    }

    function getLocalStream() { return localStream; }

    function close() {
      try { if (pc) { pc.getSenders().forEach(s => { if (s.track) s.track.stop(); }); pc.close(); } } catch(e){}
      pc = null;
      if (localStream) {
        try { localStream.getTracks().forEach(t => t.stop()); } catch(e){}
        localStream = null;
      }
      try { if (socket && socket.readyState === WebSocket.OPEN) socket.close(); } catch(e){}
      socket = null;
      joinedSession = null;
      onState("closed");
    }

    if (autoGetMic) {
      try { localStream = await getMicrophoneStream(); onState("mic-ready"); } catch(e) { /* ignore */ }
    }

    return { join, close, getLocalStream, ensureSocket, socket: () => socket };
  }

  window.WebRTCClient = { init };
})();