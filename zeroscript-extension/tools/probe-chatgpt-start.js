// tools/probe-chatgpt-start.js - OPTIONAL developer probe (not shipped, not part
// of the default test run): boot the real ZeroScript content scripts in jsdom
// against a synthetic chatgpt.com page, click the Start control and print what
// the standard startup path actually did.
//
// The shipped tests (test-agent-startup.js, test-manifest.js, test-chatgpt.js,
// test-parser.js) are dependency-free on purpose. This probe is the one check
// that needs a real DOM implementation, because it is the only way to prove the
// WHOLE chain without a signed-in browser session:
//
//     bar renders -> Start control -> agent bootstrap -> provider send
//
// It is still NOT a live verification: the page is synthetic, the bridge is a
// stub, and no Roblox Studio is involved. Report its output as such.
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
const ok = (name, cond, detail) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (!cond && detail ? "  -> " + detail : ""));
  if (!cond) process.exitCode = 1;
};

// A synthetic chatgpt.com: an empty thread + the ProseMirror composer inside the
// composer surface the provider's barMount() targets.
const html = `<!DOCTYPE html><html><head><title>ChatGPT</title></head><body>
  <main>
    <div id="thread"></div>
    <form class="w-full">
      <div class="composer-surface-primary" id="surface"
           style="grid-template-areas: &quot;eyebrow&quot; &quot;controls&quot; &quot;body&quot;;">
        <div class="prosemirror-parent">
          <div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div>
        </div>
        <div id="controls">
          <button id="composer-submit-button" data-testid="send-button">Send</button>
        </div>
      </div>
    </form>
  </main>
</body></html>`;

const dom = new JSDOM(html, { url: "https://chatgpt.com/", runScripts: "dangerously", pretendToBeVisual: true });
const win = dom.window;
const doc = win.document;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Stub the extension APIs the content script expects ─────────────────────
const msgs = [];
win.chrome = {
  runtime: {
    id: "probe", lastError: null,
    getManifest: () => ({ version: JSON.parse(read("manifest.json")).version }),
    sendMessage: (msg, cb) => {
      msgs.push(msg.type);
      // A healthy bridge + Studio with a place loaded.
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
      set: (_o, cb) => { if (typeof cb === "function") setTimeout(cb, 0); return Promise.resolve(); },
    },
  },
};

// ProseMirror's editing pipeline: execCommand writes into the editor.
doc.execCommand = (cmd, _ui, val) => {
  const ed = doc.getElementById("prompt-textarea");
  if (!ed) return false;
  if (cmd === "insertText") ed.textContent += val || "";
  else if (cmd === "insertLineBreak") ed.textContent += "\n";
  else if (cmd === "delete") ed.textContent = "";
  ed.dispatchEvent(new win.Event("input", { bubbles: true }));
  return true;
};
// jsdom has no layout: fake the "is the control visible" check the provider makes.
Object.defineProperty(win.HTMLElement.prototype, "offsetParent", { get() { return this.parentNode; } });

let sendClicks = 0;
doc.getElementById("composer-submit-button").addEventListener("click", () => {
  sendClicks++;
  const ed = doc.getElementById("prompt-textarea");
  const text = ed.textContent;
  ed.textContent = ""; // ChatGPT clears the composer as the send is accepted
  if (!text) return;
  const user = doc.createElement("div");
  user.setAttribute("data-message-author-role", "user");
  user.setAttribute("data-message-id", "u" + sendClicks);
  const p = doc.createElement("p");
  p.textContent = text;
  user.appendChild(p);
  doc.getElementById("thread").appendChild(user);
});

win.addEventListener("error", (e) => console.log("PAGE ERROR:", e.message));

// ── Boot exactly what manifest.json injects, in its declared order ─────────
const entry = JSON.parse(read("manifest.json")).content_scripts
  .find((e) => (e.matches || []).includes("https://chatgpt.com/*") && (e.js || []).includes("core/main.js"));
for (const file of entry.js) {
  const s = doc.createElement("script");
  s.textContent = read(file);
  doc.documentElement.appendChild(s);
}

(async () => {
  await sleep(400);
  const action = doc.getElementById("zs-action");
  const state = doc.getElementById("zs-state");
  // The core's readiness check renders this instead of a bar when the loaded
  // provider is not a ZeroScript agent provider (see core/main.js).
  const fatal = doc.getElementById("zs-provider-fatal");
  console.log("\n--- before the click ---");
  console.log(`bar            : ${doc.getElementById("zs-bar") ? "rendered, inside " + doc.getElementById("zs-bar").parentElement.id : "MISSING"}`);
  if (fatal) console.log(`fatal banner   : ${fatal.textContent}`);
  ok("the Start control is rendered on a blank ChatGPT chat",
    !!action && /Start Roblox agent/.test(action.textContent),
    fatal ? "core showed a fatal banner instead" : "no #zs-action in the bar");
  if (!action) return process.exit(1);
  ok("the control is the standard start action", action.dataset.kind === "start");
  ok("the control is enabled with the bridge up", action.disabled === false);
  console.log(`state line     : ${state.textContent}`);
  action.click();
  await sleep(1200);

  const diag = (win.__zsDiag || []).map((d) => d.event);
  console.log("\n--- after the click ---");
  console.log(`state line     : ${state.textContent}`);
  console.log(`diag           : ${diag.join(", ")}`);
  console.log(`bridge messages: ${msgs.join(", ")}`);
  console.log(`send clicks    : ${sendClicks}`);
  const firstUser = doc.querySelector("[data-message-author-role='user']");
  const sentText = firstUser ? firstUser.textContent : "";

  ok("the control switched to the starting state", /Starting/.test(state.textContent));
  ok("the agent asked the bridge for the tool catalogue", diag.includes("tools.fetched"));
  ok("the provider reported the composer ready", diag.includes("mode_ready"));
  ok("the agent sent the ZeroScript system prompt through the provider", /⟦ZS-SYS⟧/.test(sentText));
  ok("the system prompt was actually submitted (send control clicked)", sendClicks === 1);
  ok("no dashboard/handoff message was sent", msgs.every((m) => /^(status|list_tools|call_tool|restart_mcp|add_server|remove_server)$/.test(m)));
  console.log("\nNOTE: jsdom + stubbed bridge. This is not a live ChatGPT/Roblox verification.");
  process.exit(process.exitCode || 0);
})();
