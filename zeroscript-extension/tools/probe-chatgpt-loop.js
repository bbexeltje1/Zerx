// tools/probe-chatgpt-loop.js - end-to-end probe (not shipped, not part of the
// default test run). Boots the REAL ZeroScript content scripts in jsdom against a
// synthetic chatgpt.com conversation rendered in the CURRENT markup
// (`[data-turn-key]` containers, no `[data-message-author-role]`), then drives
// the whole standalone flow:
//
//   Start -> bootstrap sent by ZS -> page echoes the user turn -> the bootstrap
//   turn is CONCEALED behind a chip -> scripted reply -> ready -> user request ->
//   {"command":"list_commands"} -> parsed -> dispatched -> result injected and
//   CONCEALED -> next reply recognised -> final answer -> loop ends.
//
// The page half is a small, event-driven model of ChatGPT: it echoes every send
// the extension performs and answers each user turn from a script, streaming the
// reply with a stop control present while it types. That removes the fixed-sleep
// races of a hand-stepped simulation - the extension owns the pacing, exactly as
// it does live.
//
// Everything here is MOCKED: synthetic DOM, scripted "model", stubbed bridge, no
// Roblox and no real ChatGPT. It is the strongest check available without a
// signed-in browser - not a substitute for one.
//
// Usage:
//   mkdir -p /tmp/zs-probe && cd /tmp/zs-probe && npm init -y && npm i jsdom
//   NODE_PATH=/tmp/zs-probe/node_modules node zeroscript-extension/tools/probe-chatgpt-loop.js
const fs = require("fs");
const path = require("path");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch {
  console.error("probe needs jsdom: npm i jsdom in a scratch dir and re-run with NODE_PATH=<that>/node_modules");
  process.exit(2);
}

const EXT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(EXT, rel), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const T0 = Date.now();
const at = () => "+" + String(Date.now() - T0).padStart(5) + "ms";
const ok = (name, cond, detail) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (!cond && detail ? "  -> " + detail : ""));
  if (!cond) failures++;
};

// ── The page: current ChatGPT markup, empty conversation ────────────────────
const HTML = `<!DOCTYPE html><html><head><title>ChatGPT</title></head><body>
  <main>
    <div id="thread" class="thread"></div>
    <form data-chatgpt-composer id="composer-form">
      <div class="relative flex">
        <div class="prosemirror-parent">
          <div class="ProseMirror" contenteditable="true" role="textbox" aria-label="Chat with ChatGPT"></div>
        </div>
        <div id="composer-controls">
          <button type="submit" id="send-btn" aria-label="Send">Send</button>
        </div>
      </div>
    </form>
  </main>
</body></html>`;

const dom = new JSDOM(HTML, { url: "https://chatgpt.com/", runScripts: "dangerously", pretendToBeVisual: true });
const win = dom.window;
const doc = win.document;
const thread = () => doc.getElementById("thread");
const editorEl = () => doc.querySelector("form div.ProseMirror[contenteditable], #prompt-textarea");

// ── Bridge stub (no Roblox anywhere: list_commands is served by the core) ───
const bridgeMsgs = [];
win.chrome = {
  runtime: {
    id: "probe", lastError: null,
    getManifest: () => ({ version: JSON.parse(read("manifest.json")).version }),
    sendMessage: (msg, cb) => {
      bridgeMsgs.push(msg.type);
      const resp = msg.type === "status"
        ? { type: "zs-status", connected: true, mcpAlive: true, studio: true, studioApp: true,
            studioProc: true, tools: 2,
            servers: [{ id: "roblox", name: "Roblox Studio", alive: true, tools: 2 }] }
        : msg.type === "list_tools"
          ? { ok: true, tools: [
              { name: "list_commands", server: "roblox" },
              { name: "script_read", server: "roblox" },
              { name: "execute_luau", server: "roblox" },
            ] }
          : { ok: true };
      if (cb) setTimeout(() => cb(resp), 0);
    },
    onMessage: { addListener: () => {} },
  },
  storage: {
    local: {
      get: (_k, cb) => { if (typeof cb === "function") setTimeout(() => cb({}), 0); return Promise.resolve({}); },
      set: (_o, cb) => { if (typeof cb === "function") setTimeout(cb, 0); return Promise.resolve({}); },
    },
  },
};

// ── Layout + editing emulation (jsdom has neither) ─────────────────────────
let lastInserted = "";
doc.execCommand = (cmd, _ui, val) => {
  const ed = editorEl();
  if (!ed) return false;
  if (cmd === "insertText") { ed.textContent += val || ""; lastInserted = val || ""; }
  else if (cmd === "insertLineBreak") ed.textContent += "\n";
  else if (cmd === "delete") ed.textContent = "";
  ed.dispatchEvent(new win.Event("input", { bubbles: true }));
  return true;
};
Object.defineProperty(win.HTMLElement.prototype, "offsetParent", {
  get() { return this.style.display === "none" ? null : this.parentNode; },
});
win.Element.prototype.getBoundingClientRect = function () {
  if (this.style && this.style.display === "none") {
    return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  }
  const w = parseFloat((this.style && this.style.width) || "") || 800;
  const h = parseFloat((this.style && this.style.height) || "") || 48;
  const left = parseFloat((this.style && this.style.left) || "") || 100;
  const top = parseFloat((this.style && this.style.top) || "") || 400;
  return { width: w, height: h, left, top, right: left + w, bottom: top + h };
};
win.innerWidth = 1280;
win.innerHeight = 900;

// ── The "site": a small model of what ChatGPT's own React app does ─────────
let turnSeq = 0;
const added = []; // { turn, role, text } in creation order

function makeTurn(role, text) {
  const key = (role === "user" ? "u" : "a") + ++turnSeq;
  const box = doc.createElement("div");
  box.setAttribute("data-turn-key", key);
  if (role === "user") {
    const bubble = doc.createElement("div");
    bubble.setAttribute("data-user-message-bubble", "true");
    const p = doc.createElement("p");
    p.textContent = text;
    bubble.appendChild(p);
    box.appendChild(bubble);
  } else {
    const h = doc.createElement("h4");
    h.setAttribute("data-conversation-role", "assistant");
    h.textContent = "ChatGPT said:";
    box.appendChild(h);
  }
  thread().appendChild(box);
  const rec = { turn: box, role, text: text || "" };
  added.push(rec);
  return rec;
}

function echoUserTurn(text) {
  return makeTurn("user", text);
}

// While a reply streams there IS a stop control (like the real page); it goes
// away when the generation ends.
function addStopButton() {
  const b = doc.createElement("button");
  b.setAttribute("aria-label", "Stop streaming");
  b.textContent = "Stop";
  doc.getElementById("composer-controls").appendChild(b);
  return b;
}
async function streamReply(rec, chunks) {
  const stop = addStopButton();
  const md = doc.createElement("div");
  md.className = "MarkdownRoot-probe";
  rec.turn.appendChild(md);
  let text = "";
  for (const chunk of chunks) {
    text += chunk;
    // React re-creates the body nodes on each token: rebuild, do not patch.
    md.textContent = "";
    const p = doc.createElement("p");
    p.textContent = text;
    md.appendChild(p);
    rec.text = text;
    await sleep(200);
  }
  await sleep(150);
  stop.remove();
  return rec;
}

// The page's own send handler: clear the composer, append the user turn. The
// real app does this from both the send button and Enter - the extension only
// observes the resulting turn, it never creates it.
function pageSend() {
  const ed = editorEl();
  const typed = ed ? ed.textContent : "";
  const text = typed || lastInserted;
  lastInserted = "";
  if (ed) ed.textContent = "";
  if (!text.trim()) return null;
  return echoUserTurn(text);
}
doc.getElementById("send-btn").addEventListener("click", (ev) => {
  ev.preventDefault();
  pageSend();
});
doc.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" || ev.shiftKey) return;
  const ed = editorEl();
  if (!ed || !ed.contains(ev.target)) return;
  ev.preventDefault();
  pageSend();
}, true);

// ── Scripted "model": answer every new user turn in order ─────────────────
// index 0 answers the ZS bootstrap, 1 answers the user's project request,
// 2 answers the injected tool result.
const script = [
  ["Ready. What should I build?"],
  ['{"command":"list_commands"}'],
  ["Done - the command list is loaded and I am ready to build."],
];
const answered = new Set();
let streaming = false;
const scriptLeft = () => script.length;
async function modelStep() {
  if (streaming || !script.length) return;
  const users = added.filter((r) => r.role === "user" && !answered.has(r.turn.dataset.turnKey));
  if (!users.length) return;
  // Answer the newest user turn only once (the site would answer each one).
  const rec = users[users.length - 1];
  answered.add(rec.turn.dataset.turnKey);
  streaming = true;
  const chunks = script.shift();
  await sleep(250);
  const box = makeTurn("assistant");
  await streamReply(box, chunks);
  streaming = false;
}
const modelTimer = setInterval(() => { modelStep(); }, 80);

// ── Boot the extension exactly as manifest.json injects it ─────────────────
const manifest = JSON.parse(read("manifest.json"));
const entry = manifest.content_scripts
  .find((e) => (e.matches || []).includes("https://chatgpt.com/*") && (e.js || []).includes("core/main.js"));
for (const file of entry.js) {
  const s = doc.createElement("script");
  s.textContent = read(file);
  doc.documentElement.appendChild(s);
}

// ── Observability ─────────────────────────────────────────────────────────
const diag = () => (win.__zsDiag || []);
const diagNames = () => diag().map((d) => d.event);
const toolStarts = () => diag().filter((d) => d.event === "tool.start").map((d) => d.data && d.data.name);
const barState = () => {
  const bar = doc.getElementById("zs-bar");
  const state = doc.getElementById("zs-state");
  const action = doc.getElementById("zs-action");
  return {
    bar: !!bar && bar.style.display !== "none",
    text: state ? state.textContent : "",
    action: action ? { label: action.textContent, kind: action.dataset.kind, disabled: action.disabled } : null,
  };
};
const isConcealed = (turn) => !!turn && turn.classList.contains("zs-hidden") && !!turn.querySelector(".zs-chip");
const chipText = (turn) => (turn && turn.querySelector(".zs-chip") ? turn.querySelector(".zs-chip").textContent : "");
const turns = () => [...thread().querySelectorAll("[data-turn-key]")];
const dumpTurns = () => turns().map((t, i) =>
  `${i}:${t.dataset.turnKey}${t.classList.contains("zs-hidden") ? "(hidden)" : ""}`).join(" ");
// Poll a condition instead of sleeping a fixed time: the loop's warm-up,
// generation watchdog and send guards are all timing-driven.
async function until(fn, ms, label) {
  const end = Date.now() + (ms || 20000);
  while (Date.now() < end) {
    try { if (fn()) return true; } catch { /* not ready yet */ }
    await sleep(50);
  }
  console.log("TIMEOUT waiting for " + (label || "condition") + "  turns: " + dumpTurns());
  return false;
}

(async () => {
  await sleep(400); // first frame: the bar is built on boot

  // ── 1. Start the agent ───────────────────────────────────────────────────
  const start = doc.getElementById("zs-action");
  ok("[start] the Start control is visible and enabled",
    !!start && /Start Roblox agent/.test(start.textContent) && start.disabled === false,
    start ? start.textContent : "no #zs-action");
  console.log(at() + " clicking Start");
  start.click();

  // The page echo of the bootstrap is what the extension then conceals.
  await until(() => turns()[0] && isConcealed(turns()[0]), 30000, "bootstrap concealed");
  const bootstrapTurn = turns()[0];
  ok("[start] the bootstrap turn reached the page",
    !!bootstrapTurn && /⟦ZS-SYS⟧/.test(bootstrapTurn.textContent));
  ok("[start] the bootstrap turn was recognised as a turn and concealed",
    isConcealed(bootstrapTurn), bootstrapTurn ? bootstrapTurn.className : "no turn");
  ok("[start] it is masked behind the ZeroScript chip, not left as a user task",
    /Starting Up/i.test(chipText(bootstrapTurn)), JSON.stringify(chipText(bootstrapTurn)).slice(0, 120));
  ok("[start] the raw ⟦ZS-SYS⟧ banner is not visible anywhere in the thread",
    ![...thread().children].some((t) => !t.classList.contains("zs-hidden") && /⟦ZS-SYS⟧/.test(t.textContent)),
    dumpTurns());

  // ── 2. Startup finishes: the bootstrap reply is read, the agent is ready ──
  await until(() => /Agent active/i.test(barState().text), 40000, "ready state");
  ok("[ready] the agent reached its normal ready state",
    /Agent active/i.test(barState().text), JSON.stringify(barState()));
  ok("[ready] the bootstrap reply was consumed without a parse error",
    !diag().some((d) => d.event === "parse.error"), JSON.stringify(diagNames().slice(-8)));
  ok("[ready] the bootstrap turn stays concealed", isConcealed(bootstrapTurn));
  ok("[ready] no ZeroScript error banner", !doc.getElementById("zs-provider-fatal"));

  // ── 3. The user asks for a project; the model answers with a command ─────
  const ed = editorEl();
  ed.textContent = "make me a shop";
  ed.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await until(() => added.some((r) => r.role === "user" && /make me a shop/.test(r.turn.textContent)),
    15000, "user request echoed");
  ok("[request] the user request was sent through the normal composer",
    added.some((r) => r.role === "user" && /make me a shop/.test(r.turn.textContent)),
    JSON.stringify(added.filter((r) => r.role === "user").map((r) => r.text.slice(0, 20))));

  await until(() => toolStarts().includes("list_commands"), 45000, "command dispatched");
  const cmdRec = added.find((r) => r.role === "assistant" && /list_commands/.test(r.text));
  ok("[command] the command reply was recognised as one assistant turn",
    !!cmdRec, dumpTurns());
  ok("[command] the command was dispatched exactly once",
    toolStarts().filter((n) => n === "list_commands").length === 1,
    JSON.stringify(toolStarts()));
  ok("[command] a running chip was painted on that turn",
    !!cmdRec && /list_commands/i.test(chipText(cmdRec.turn)), cmdRec ? chipText(cmdRec.turn) : "no turn");
  // An assistant command turn is not hidden as a whole (its prose stays); the
  // command block itself is masked by the provider's findToolBlockSpot.
  const cmdMasked = (turn) => !!turn && (isConcealed(turn) ||
    [...turn.querySelectorAll("p, pre")].some((el) => el.classList.contains("zs-tool-hide")) ||
    [...turn.querySelectorAll("[class*='MarkdownRoot'], .markdown")]
      .some((el) => /zs-cmd-mask/.test(el.className)));
  await until(() => !!cmdRec && cmdMasked(cmdRec.turn), 15000, "command turn masked");
  ok("[command] the command body was masked in the reply",
    !!cmdRec && cmdMasked(cmdRec.turn),
    cmdRec ? cmdRec.turn.outerHTML.slice(0, 300) : "no turn");
  ok("[command] the masking is anchored on the reply root, not the whole turn",
    !!cmdRec && !cmdRec.turn.classList.contains("zs-hidden"),
    cmdRec ? cmdRec.turn.className : "no turn");

  // ── 4. The result is injected, concealed, and the model continues ────────
  const resultRec = () => added.find((r) => r.role === "user" && /Output of 'list_commands'/.test(r.text));
  await until(() => !!resultRec(), 30000, "tool result injected");
  ok("[result] the tool result was injected as the next user turn",
    !!resultRec(), JSON.stringify(added.filter((r) => r.role === "user").map((r) => r.text.slice(0, 24))));
  await until(() => !!resultRec() && isConcealed(resultRec().turn), 20000, "result concealed");
  const rr = resultRec();
  ok("[result] the injected result was concealed behind a chip",
    isConcealed(rr && rr.turn), rr ? rr.turn.className : "no turn");
  ok("[result] the injected result is classified as extension feedback, not a user task",
    !!rr && rr.turn.dataset.zs === "result" &&
      /\bresult\b/.test((rr.turn.querySelector(".zs-chip") || {}).className || ""),
    rr ? rr.turn.dataset.zs + " / " + rr.turn.className : "no turn");
  ok("[result] the parser's injected-feedback rule matches the injected text",
    !!rr && !!win.eval("ZSParse").isInjectedFeedback(rr.text),
    rr ? rr.text.slice(0, 40) : "no turn");

  // ── 5. The model's final answer ends the loop ────────────────────────────
  await until(() => diag().some((d) => d.event === "loop.end"), 40000, "loop end");
  ok("[loop] the loop ended on the final answer instead of waiting forever",
    diag().some((d) => d.event === "loop.end"), JSON.stringify(diagNames().slice(-10)));
  ok("[loop] the final answer was read as text, not re-parsed as a command",
    diag().some((d) => d.event === "response" && d.data && d.data.kind === "text"),
    JSON.stringify(diag().filter((d) => d.event === "response").map((d) => d.data && d.data.kind)));
  ok("[loop] the follow-up reply produced no parse error",
    !diag().some((d) => d.event === "parse.error"), JSON.stringify(diagNames().slice(-10)));
  ok("[loop] every user turn except the injection is still visible (nothing over-hidden)",
    turns().filter((t) => !t.classList.contains("zs-hidden")).length >= 2, dumpTurns());
  ok("[loop] only bridge messages were used",
    bridgeMsgs.every((m) => /^(status|list_tools|call_tool|restart_mcp|add_server|remove_server)$/.test(m)),
    bridgeMsgs.join(", "));

  ok("[diag] the provider reported the current markup as its turn model",
    diag().some((d) => d.event === "turns.model" && d.data && d.data.model === "container" &&
      d.data.probes && d.data.probes.turnKey),
    JSON.stringify(diag().filter((d) => String(d.event).startsWith("turns"))
      .map((d) => d.event + ":" + ((d.data || {}).model))));
  // A working conversation must never be reported as unrecognisable - not even
  // once during Start (the bootstrap sitting in the composer is not a mismatch).
  const unrec = diag().filter((d) => d.event === "turns.unrecognized");
  ok("[diag] a healthy conversation is never reported as unrecognised",
    unrec.length === 0, JSON.stringify(unrec.map((d) => d.data)));

  clearInterval(modelTimer);
  console.log("TURNS:", dumpTurns());
  console.log("DIAG:", diagNames().join(", "));
  console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nALL LOOP CHECKS PASSED");
  console.log("NOTE: jsdom + synthetic ChatGPT markup + scripted model + stubbed bridge. Not live verification.");
  process.exit(failures ? 1 : 0);
})();
