// tools/probe-chatgpt-start.js - OPTIONAL developer probe (not shipped, not part
// of the default test run): boot the real ZeroScript content scripts in jsdom
// and check what the bar actually looks like, scenario by scenario.
//
// The shipped tests (test-chatgpt-composer.js, test-agent-startup.js,
// test-manifest.js, test-chatgpt.js, test-parser.js) are dependency-free. This
// probe is the only check that needs a real DOM implementation, because the
// things it asserts are CSS/layout facts that a hand-rolled stub cannot model:
//
//   1. legacy shell (with #prompt-textarea)      -> bar visible, Start enabled,
//                                                   click runs the bootstrap
//   2. current shell (ProseMirror textbox, no id) -> same, with the bar FLOATING
//                                                   (non-zero rect) rather than
//                                                   mounted into the composer grid
//   3. composer that mounts 600ms after load      -> bar hidden first, then
//                                                   visible without a reload
//   4. blocking overlay (provider overlayBlocking) -> bar hidden, then restored
//
// Still NOT a live verification: the page is synthetic, the bridge is a stub and
// jsdom has no real layout engine (getBoundingClientRect is emulated below).
//
// Usage:
//   mkdir -p /tmp/zs-probe && cd /tmp/zs-probe && npm init -y && npm i jsdom
//   NODE_PATH=/tmp/zs-probe/node_modules node zeroscript-extension/tools/probe-chatgpt-start.js
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
const ok = (name, cond, detail) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (!cond && detail ? "  -> " + detail : ""));
  if (!cond) failures++;
};

// The page shells. `modern` mirrors the 2026-09 "Chat / Work" composer: a
// ProseMirror textbox with no id inside the composer form.
const shells = {
  legacy: `<main><div id="thread"></div>
    <form class="w-full" id="composer-form">
      <div class="composer-surface-primary" id="surface"
           style="grid-template-areas: &quot;eyebrow&quot; &quot;controls&quot; &quot;body&quot;;">
        <div class="prosemirror-parent">
          <div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div>
        </div>
        <div id="controls"><button id="composer-submit-button" data-testid="send-button">Send</button></div>
      </div>
    </form></main>`,
  modern: `<main><div id="thread"></div>
    <form data-chatgpt-composer id="composer-form">
      <div class="flex w-full flex-col">
        <div class="prosemirror-parent">
          <div class="ProseMirror" contenteditable="true" role="textbox" aria-label="Chat with ChatGPT"></div>
        </div>
        <div><button type="submit" id="composer-submit-button">Send</button></div>
      </div>
    </form></main>`,
  late: `<main><div id="thread"></div><div id="mount-point"></div></main>`,
};

function boot(shellHtml, opts) {
  const o = opts || {};
  const dom = new JSDOM(`<!DOCTYPE html><html><head><title>ChatGPT</title></head><body>${shellHtml}</body></html>`, {
    url: "https://chatgpt.com/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const doc = win.document;
  const msgs = [];

  win.chrome = {
    runtime: {
      id: "probe", lastError: null,
      getManifest: () => ({ version: JSON.parse(read("manifest.json")).version }),
      sendMessage: (msg, cb) => {
        if (o.blockingMessages) return; // a hung/dashboard-style handshake
        msgs.push(msg.type);
        const resp = msg.type === "status"
          ? { type: "zs-status", connected: true, mcpAlive: true, studio: true, studioApp: true,
              studioProc: true, tools: 2,
              servers: [{ id: "roblox", name: "Roblox Studio", alive: true, tools: 2 }] }
          : msg.type === "list_tools"
            ? { ok: true, tools: [{ name: "execute_luau", server: "roblox" }, { name: "script_read", server: "roblox" }] }
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

  // The editing pipeline the provider drives.
  doc.execCommand = (cmd, _ui, val) => {
    const ed = doc.querySelector("#prompt-textarea, form div.ProseMirror[contenteditable='true']");
    if (!ed) return false;
    if (cmd === "insertText") ed.textContent += val || "";
    else if (cmd === "insertLineBreak") ed.textContent += "\n";
    else if (cmd === "delete") ed.textContent = "";
    ed.dispatchEvent(new win.Event("input", { bubbles: true }));
    return true;
  };
  // jsdom has no layout: emulate the two facts the bar's positioning depends on.
  Object.defineProperty(win.HTMLElement.prototype, "offsetParent", {
    get() { return this.style.display === "none" ? null : this.parentNode; },
  });
  win.Element.prototype.getBoundingClientRect = function () {
    if (this.style && this.style.display === "none") {
      return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0, x: 0, y: 0 };
    }
    const w = parseFloat((this.style && this.style.width) || "") || 800;
    const h = parseFloat((this.style && this.style.height) || "") || 48;
    const left = parseFloat((this.style && this.style.left) || "") || 100;
    const top = parseFloat((this.style && this.style.top) || "") || 400;
    return { width: w, height: h, left, top, right: left + w, bottom: top + h, x: left, y: top };
  };
  win.innerWidth = 1280;
  win.innerHeight = 900;

  let sendClicks = 0;
  const wireSend = () => {
    const btn = doc.getElementById("composer-submit-button");
    if (!btn || btn.__wired) return;
    btn.__wired = true;
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      sendClicks++;
      const ed = doc.querySelector("#prompt-textarea, form div.ProseMirror[contenteditable='true']");
      const text = ed ? ed.textContent : "";
      if (ed) ed.textContent = "";
      if (!text) return;
      const turn = doc.createElement("div");
      turn.setAttribute("data-message-author-role", "user");
      turn.setAttribute("data-message-id", "u" + sendClicks);
      const p = doc.createElement("p");
      p.textContent = text;
      turn.appendChild(p);
      doc.getElementById("thread").appendChild(turn);
    });
  };
  wireSend();

  // Load exactly what manifest.json injects, in its declared order.
  const entry = JSON.parse(read("manifest.json")).content_scripts
    .find((e) => (e.matches || []).includes("https://chatgpt.com/*") && (e.js || []).includes("core/main.js"));
  for (const file of entry.js) {
    if (file === "providers/chatgpt.js" && o.patchProvider) {
      // Injected hook for the overlay scenario: providers that implement
      // captchaPresent()/overlayBlocking() make the core duck the bar.
      const src = read(file).replace("  return {\n    id: \"chatgpt\",", "  return {\n" + o.patchProvider + "\n    id: \"chatgpt\",");
      const s = doc.createElement("script");
      s.textContent = src;
      doc.documentElement.appendChild(s);
      continue;
    }
    const s = doc.createElement("script");
    s.textContent = read(file);
    doc.documentElement.appendChild(s);
  }
  return { win, doc, msgs, sendClicks: () => sendClicks, wireSend };
}

const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
};
const barState = (doc) => {
  const bar = doc.getElementById("zs-bar");
  if (!bar) return { present: false };
  const action = doc.getElementById("zs-action");
  const rect = bar.getBoundingClientRect();
  return {
    present: true,
    display: bar.style.display || "(css default)",
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    action: action ? { text: action.textContent, kind: action.dataset.kind, disabled: action.disabled } : null,
    parent: bar.parentElement ? (bar.parentElement.id || bar.parentElement.tagName) : null,
    state: (doc.getElementById("zs-state") || {}).textContent,
  };
};

// ── Scenario 1 + 2: legacy and current shells ─────────────────────────────
async function visibleScenario(name, shell) {
  const { doc, msgs, sendClicks } = boot(shell);
  await sleep(400);
  const before = barState(doc);
  console.log(`\n--- [${name}] before the click ---`);
  console.log(`bar: display=${before.display} rect=${before.width}x${before.height} parent=${before.parent}`);
  console.log(`state: ${before.state}`);

  ok(`[${name}] the bar is rendered`, before.present);
  ok(`[${name}] the bar is NOT hidden (display !== none)`, before.display !== "none", before.display);
  ok(`[${name}] the bar has a measurable, non-zero rect`, before.width > 0 && before.height > 0,
    `${before.width}x${before.height}`);
  ok(`[${name}] the Start control is visible and enabled`,
    !!before.action && /Start Roblox agent/.test(before.action.text) && before.action.disabled === false,
    JSON.stringify(before.action));
  ok(`[${name}] the control is the standard start action`, before.action && before.action.kind === "start");

  doc.getElementById("zs-action").click();
  await sleep(1200);
  const after = barState(doc);
  const diag = (doc.defaultView.__zsDiag || []).map((d) => d.event);
  const sent = doc.querySelector("[data-message-author-role='user']");
  const sentText = sent ? sent.textContent : "";
  console.log(`--- [${name}] after the click ---`);
  console.log(`state: ${after.state}`);
  console.log(`diag:  ${diag.join(", ")}`);
  console.log(`bridge messages: ${msgs.join(", ")}`);

  ok(`[${name}] clicking Start runs the ordinary bootstrap (tools + provider send)`,
    diag.includes("tools.fetched") && diag.includes("mode_ready") && diag.includes("submit.typeAndSend"));
  ok(`[${name}] the system prompt went through the provider adapter`, /⟦ZS-SYS⟧/.test(sentText));
  ok(`[${name}] the message was actually submitted`, sendClicks() === 1);
  ok(`[${name}] the bar switched to the starting state`, /Starting/.test(after.state || ""));
  ok(`[${name}] no dashboard-shaped message was sent`,
    msgs.every((m) => /^(status|list_tools|call_tool|restart_mcp|add_server|remove_server)$/.test(m)));
}

// ── Scenario 3: the composer mounts after init ────────────────────────────
async function lateComposerScenario() {
  const { doc, win } = boot(shells.late);
  await sleep(500);
  const early = barState(doc);
  console.log("\n--- [late] composer not mounted yet ---");
  console.log(`bar: display=${early.display} rect=${early.width}x${early.height} present=${early.present}`);
  ok("[late] the bar exists but is safely hidden while there is no composer",
    early.present && early.display === "none" && early.width === 0, JSON.stringify(early));
  ok("[late] no ZeroScript fatal banner is shown", !doc.getElementById("zs-provider-fatal"));

  // React mounts the composer (the real cold-load case).
  doc.getElementById("mount-point").innerHTML = shells.modern
    .replace(/^<main>/, "").replace(/<\/main>$/, "");
  wireSendAgain(win, doc);
  await sleep(700);

  const late = barState(doc);
  console.log("--- [late] composer mounted ---");
  console.log(`bar: display=${late.display} rect=${late.width}x${late.height} parent=${late.parent}`);
  const diagEvents = (win.__zsDiag || []).map((d) => d.event + (d.data && d.data.reason ? ":" + d.data.reason : ""));
  console.log(`diag:  ${diagEvents.join(", ")}`);
  ok("[late] the reason is self-reported in [zs-diag] (bar.hidden no-composer)",
    diagEvents.includes("bar.hidden:no-composer"), diagEvents.join(", "));
  ok("[late] the bar recovers by itself once the composer appears",
    late.display !== "none" && late.width > 0 && late.height > 0, JSON.stringify(late));
  ok("[late] the recovery is reported too (bar.shown)", diagEvents.includes("bar.shown"));
  ok("[late] the Start control is visible and enabled after recovery",
    !!late.action && /Start Roblox agent/.test(late.action.text) && late.action.disabled === false,
    JSON.stringify(late.action));
}

// The late-mounted form needs its send button wired like the initial ones.
function wireSendAgain(win, doc) {
  const btn = doc.getElementById("composer-submit-button");
  if (!btn || btn.__wired) return;
  btn.__wired = true;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    const ed = doc.querySelector("#prompt-textarea, form div.ProseMirror[contenteditable='true']");
    if (ed) ed.textContent = "";
  });
}

// ── Scenario 4: a blocking overlay hides the bar, then it comes back ──────
async function overlayScenario() {
  const patch = "    overlayBlocking: () => !!window.__zsProbeOverlay,";
  const { doc, win } = boot(shells.modern, { patchProvider: patch });
  await sleep(400);
  const normal = barState(doc);
  ok("[overlay] the bar is visible with no overlay", normal.display !== "none" && normal.width > 0);

  win.__zsProbeOverlay = true; // e.g. the login / consent modal
  await sleep(300);
  const blocked = barState(doc);
  console.log("\n--- [overlay] blocking overlay present ---");
  console.log(`bar: display=${blocked.display} rect=${blocked.width}x${blocked.height}`);
  ok("[overlay] a blocking overlay hides the bar safely (no click interception)",
    blocked.display === "none" && blocked.width === 0, JSON.stringify(blocked));

  win.__zsProbeOverlay = false;
  await sleep(300);
  const restored = barState(doc);
  ok("[overlay] the bar returns as soon as the overlay clears",
    restored.display !== "none" && restored.width > 0 && restored.height > 0, JSON.stringify(restored));
}

(async () => {
  await visibleScenario("legacy", shells.legacy);
  await visibleScenario("modern", shells.modern);
  await lateComposerScenario();
  await overlayScenario();
  console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nALL PROBE CHECKS PASSED");
  console.log("NOTE: jsdom + stubbed bridge. Not a live ChatGPT/Roblox verification.");
  process.exit(failures ? 1 : 0);
})();
