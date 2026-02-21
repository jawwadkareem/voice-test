// public/widget.js
(async () => {
  const messagesEl = document.getElementById("messages");
  const txt = document.getElementById("txt");
  const send = document.getElementById("send");

  let sessionId = null;
  async function init() {
    const r = await fetch("/api/chat/init", { method: "POST", headers: { "Content-Type":"application/json" }});
    const j = await r.json();
    sessionId = j.sessionId;
    appendAssistant("Hi — I'm the assistant. How can I help today?");
  }
  function appendUser(t) {
    const d = document.createElement("div"); d.className="m user"; d.textContent = t; messagesEl.appendChild(d); messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function appendAssistant(t) {
    const d = document.createElement("div"); d.className="m assistant"; d.textContent = t; messagesEl.appendChild(d); messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  send.addEventListener("click", async () => {
    const message = txt.value.trim();
    if (!message) return;
    appendUser(message);
    txt.value = "";
    appendAssistant("…thinking…");
    const resp = await fetch("/api/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message, channel: "web" })
    });
    const j = await resp.json();
    // remove the last "thinking" node
    const last = Array.from(messagesEl.children).pop();
    if (last && last.textContent === "…thinking…") messagesEl.removeChild(last);
    if (j?.text) appendAssistant(j.text);
    if (j?.collected) console.log("collected fields:", j.collected);
  });

  txt.addEventListener("keypress", (e) => { if (e.key === "Enter") send.click(); });

  await init();
})();