// Regression tests for the STANDALONE ZeroScript agent startup path
// (run: node test-agent-startup.js). Not shipped.
//
// Why this exists: the zero-config promise is "open the AI chat, click
// Start Roblox agent". A provider that stops being an ordinary agent provider -
// because a build patch turned it into a prompt generator, or gated the start
// control behind a dashboard/handoff handshake - fails in the worst possible
// way: the page loads, the bar is there, and nothing can start. These tests pin
// the three things that make that impossible:
//
//   1. PROVIDER CONTRACT  - every provider (ChatGPT included) exposes the whole
//      ZSProvider surface core/main.js drives, and core/main.js declares that
//      list itself (REQUIRED_PROVIDER_API), so the guard and the test agree.
//   2. STARTUP WIRING     - core/main.js renders a Start control, onActionClick
//      routes it to startSession(), and startSession() is the ordinary agent
//      bootstrap: list_tools -> system prompt -> provider.typeAndSend.
//   3. NO DASHBOARD       - nothing in the standalone path asks for a dashboard,
//      pairing, task id, handoff or "Prompt Architect" mode; the only messages
//      the content script sends are the bridge ones.
//
// Everything runs against a stub DOM (the same approach as test-chatgpt.js: the
// repo stays dependency-free, no jsdom, no npm install). Nothing here talks to
// a real ChatGPT tab, a real bridge or Roblox Studio - those need a live browser
// (see tools/probe-chatgpt-start.js for the jsdom click-through probe).
const fs = require("fs");
const path = require("path");

const EXT = __dirname;
const read = (rel) => fs.readFileSync(path.join(EXT, rel), "utf8");

const ok = (name, cond, detail) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (!cond && detail ? "  -> " + detail : ""));
  if (!cond) process.exitCode = 1;
};

// ── Stub DOM ────────────────────────────────────────────────────────────────
// Just enough browser surface for a provider IIFE to evaluate and for
// typeAndSend() to type into a fake ProseMirror composer and click the send
// button. Anything a provider reaches for that is NOT here stays undefined on
// purpose: a provider that starts needing more browser API should fail loudly in
// this test rather than quietly in the field.
function makeStub(overrides) {
  const listeners = [];
  const doc = {
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({
      setAttribute() {}, getAttribute: () => null, appendChild() {}, remove() {},
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      style: {}, dataset: {}, addEventListener() {}, dispatchEvent() {},
    }),
    createRange: () => ({ selectNodeContents() {} }),
    addEventListener: (t, f) => listeners.push([t, f]),
    removeEventListener() {},
    dispatchEvent: () => true,
    execCommand: () => false,
    hidden: false,
    documentElement: {
      classList: { add() {}, remove() {}, contains: () => false },
      setAttribute() {}, appendChild() {},
    },
    body: null,
  };
  const win = {
    location: { pathname: "/" },
    addEventListener() {}, removeEventListener() {},
    getComputedStyle: () => ({}),
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    requestAnimationFrame: (f) => setTimeout(f, 0),
    cancelAnimationFrame: () => {},
    // qwen.js patches the textarea value setter (its composer is a <textarea>).
    HTMLTextAreaElement: class { get value() { return ""; } set value(_v) {} },
    HTMLInputElement: class {},
    Element: class {},
    Node: class {},
  };
  Object.assign(doc, overrides && overrides.document);
  Object.assign(win, overrides && overrides.window);
  return { doc, win, listeners };
}

// Evaluate config + parser + one provider against the stub globals, exactly the
// way the three content scripts share one scope in the browser.
function loadProvider(file, stub) {
  const { doc, win } = stub;
  const g = global;
  const saved = {};
  const set = (k, v) => { saved[k] = g[k]; g[k] = v; };
  set("document", doc);
  set("window", win);
  set("location", win.location);
  set("navigator", { clipboard: { writeText: () => Promise.resolve() }, userAgent: "node-test" });
  set("CustomEvent", class { constructor(t) { this.type = t; } });
  set("MutationObserver", class { observe() {} disconnect() {} takeRecords() { return []; } });
  set("getComputedStyle", () => ({}));
  set("requestAnimationFrame", win.requestAnimationFrame);
  set("cancelAnimationFrame", win.cancelAnimationFrame);
  // Providers are browser IIFEs: they close over the globals they saw at load
  // time, so these stay installed for the rest of the run (each loadProvider call
  // re-installs its own stub first).
  void saved;
  const src = read("core/config.js") + "\n;\n" + read("core/parser.js") + "\n;\n" + read("providers/" + file) +
    "\n;return { P: ZSProvider, ZS: ZS, ZSParse: ZSParse };";
  return new Function(src)();
}

const PROVIDER_FILES = fs
  .readdirSync(path.join(EXT, "providers"))
  .filter((f) => f.endsWith(".js"))
  // The two MAIN-world taps are helpers injected alongside a provider, not
  // providers themselves (they publish editor text onto data-zs-cm / stash the
  // network replies); they have no ZSProvider.
  .filter((f) => !f.endsWith("-cm.js") && !f.endsWith("-net.js"))
  .sort();

const CORE = read("core/main.js");

// ── 1. The provider contract ────────────────────────────────────────────────
// core/main.js is the single source of truth for what a provider must expose:
// it fails the boot loudly when a member is missing (see the readiness check at
// the top of the file). Read the list back OUT of the core so this test can
// never drift from it.
const requiredBlock = CORE.match(/const REQUIRED_PROVIDER_API = \[([\s\S]*?)\];/);
ok("core declares REQUIRED_PROVIDER_API", !!requiredBlock);
const REQUIRED = requiredBlock ? [...requiredBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
ok("the required-provider list is substantial", REQUIRED.length >= 30, `got ${REQUIRED.length}`);
ok("the readiness check runs BEFORE the core touches the provider",
  CORE.indexOf("REQUIRED_PROVIDER_API") >= 0 &&
  CORE.indexOf("REQUIRED_PROVIDER_API") < CORE.indexOf("const T = P.timings"));

for (const file of PROVIDER_FILES) {
  let mod;
  try {
    mod = loadProvider(file, makeStub());
  } catch (e) {
    ok(`${file} evaluates against the stub DOM`, false, e.message);
    continue;
  }
  const P = mod.P;
  ok(`${file} exports ZSProvider`, !!P && typeof P === "object");
  if (!P) continue;
  const missing = REQUIRED.filter((k) => typeof P[k] === "undefined");
  ok(`${file} implements the full agent provider contract`, missing.length === 0, missing.join(", "));
  ok(`${file} declares a non-empty id + displayName`, !!P.id && !!P.displayName);
  ok(`${file} declares numeric timings`, !!P.timings && Object.values(P.timings).every((v) => typeof v === "number"));
  // A provider is an AGENT adapter, not a prompt generator: these are the calls
  // the bootstrap and the loop cannot work without.
  ok(`${file} can drive a conversation (type and read turns)`,
    typeof P.typeAndSend === "function" && typeof P.allItems === "function" &&
    typeof P.readAssistant === "function" && typeof P.installSendHooks === "function");
}

// ChatGPT specifically: it must be an ordinary provider with no extra startup
// gate. A provider-side modeWarning() disables the Start control (Arena's Direct
// mode guard), and a "prompt architect" build would show up as anything that
// computes a prompt instead of driving the chat.
{
  const { P } = loadProvider("chatgpt.js", makeStub());
  ok("ChatGPT reports the chatgpt provider id", P.id === "chatgpt");
  ok("ChatGPT exposes no modeWarning (so the Start control can never be disabled by one)",
    typeof P.modeWarning === "undefined");
  ok("ChatGPT has no prompt/architect helper API",
    !["promptArchitect", "buildPrompt", "generatePrompt", "promptOnly", "isPromptArchitect", "handoff"]
      .some((k) => typeof P[k] !== "undefined"));
  ok("ChatGPT keeps its composer handling (the live-validated selectors)",
    /#prompt-textarea/.test(read("providers/chatgpt.js")) &&
    /#composer-submit-button/.test(read("providers/chatgpt.js")));
}

// ── 2. Startup wiring in the core ───────────────────────────────────────────
ok("the bar template carries a primary action button", /id="zs-action"/.test(CORE));
ok("a standby/fresh chat renders the Start Roblox agent control",
  /label = "▶︎ Start Roblox agent"; kind = "start"/.test(CORE));
ok("a degraded start (Roblox offline, addon MCP alive) is still a start",
  /label = "▶︎ Start agent \(Roblox offline\)"; kind = "start-degraded"/.test(CORE));
ok("clicking the control routes to the ordinary agent bootstrap",
  /function onActionClick\(\)[\s\S]{0,300}kind === "start" \|\| kind === "start-degraded"[\s\S]{0,80}startSession\(\)/.test(CORE));
ok("the bootstrap is the normal agent loop (tools -> system prompt -> provider send)",
  /async function startSession\(\)[\s\S]*?await ensureTools\(true\)[\s\S]*?P\.ensureComposerReady\("startup"\)[\s\S]*?submitAndGetBase\(prompt\)/.test(CORE));
ok("the bootstrap sends through the provider adapter, not a bespoke path",
  /async function submitAndGetBase\(text, images\)[\s\S]*?await P\.typeAndSend\(text, images\)/.test(CORE));
ok("a completed bootstrap enters the normal ready state",
  /A\.started = true;[\s\S]{0,200}ui\.setStarted\(true\)/.test(CORE));
ok("the bar is built and rendered at boot, unconditionally",
  /^    build\(\);$/m.test(CORE) && /function build\(\)[\s\S]*?renderBar\(\);\s*placeBar\(\);/.test(CORE));

// ── 3. No dashboard prerequisite anywhere in the standalone path ────────────
const STANDALONE_FILES = [
  "manifest.json", "background.js", "popup.js", "popup.html", "core/config.js",
  "core/parser.js", "core/main.js", ...PROVIDER_FILES.map((f) => "providers/" + f),
];
const DASHBOARD_TOKENS = [
  "dashboard", "handoff", "hand-off", "prompt architect", "prompt-architect",
  "promptarchitect", "pairing", "pairingcode", "taskid", "task_id",
  "operation record", "operationrecord",
];
// Comments are stripped before scanning: the words appear in ordinary prose
// ("Handoff window: a JUST-finished command..."), but a dashboard DEPENDENCY
// would be an identifier or a string in live code.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
const offenders = [];
for (const rel of STANDALONE_FILES) {
  const src = stripComments(read(rel)).toLowerCase();
  for (const tok of DASHBOARD_TOKENS) if (src.includes(tok)) offenders.push(`${rel}: ${tok}`);
}
ok("no dashboard / handoff / Prompt Architect dependency in the standalone path",
  offenders.length === 0, offenders.join("; "));

ok("the standalone path never references dashboard script files",
  !/dashboard-handoff\.js|prompt-architect\.js/.test(read("manifest.json")));

// The content script talks to the background worker only about the local bridge.
// If a startup ever needed dashboard connectivity, a new message type would show
// up here - and this list is the whole protocol the standalone agent uses.
const msgTypes = [...new Set([...CORE.matchAll(/type:\s*"([a-z_]+)"/g)].map((m) => m[1]))];
const BACKGROUND_MSGS = new Set([...read("background.js").matchAll(/case\s+"([a-z_]+)"/g)].map((m) => m[1]));
ok("the service worker implements a bridge-only protocol", BACKGROUND_MSGS.size >= 5,
  [...BACKGROUND_MSGS].join(", "));
const unimplemented = msgTypes.filter((t) => !BACKGROUND_MSGS.has(t));
ok("every message the content script sends is handled by the bridge worker",
  unimplemented.length === 0, unimplemented.join(", "));
const dashboardMsgs = msgTypes.filter((t) => /dashboard|handoff|architect|pair/.test(t));
ok("startup sends no dashboard-shaped message", dashboardMsgs.length === 0, dashboardMsgs.join(", "));
ok("startup asks the bridge for the tool catalogue",
  /await bg\(\{ type: "list_tools" \}\)/.test(CORE));

// ── 4. Runtime: the ChatGPT adapter submits the bootstrap prompt ────────────
// The core's startSession() hands the provider the system prompt (built by
// core/config.js, carrying the SYS_MARKER the camouflage sweep keys on) and
// expects it to land in the composer and be submitted. This drives that exact
// call against a fake chatgpt.com composer - no dashboard, no pairing, nothing
// but the adapter.
(async () => {
  const clicks = [];
  const editor = {
    nodeType: 1,
    tagName: "DIV",
    textContent: "",
    attrs: { contenteditable: "true", id: "prompt-textarea" },
    hidden: false,
    focused: false,
    focus() { this.focused = true; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    dispatchEvent() { return true; },
    closest() { return null; },
    querySelector: () => null,
    querySelectorAll: () => [],
    matches: () => false,
    addEventListener() {},
  };
  const sendBtn = {
    disabled: false,
    offsetParent: {}, // visible (the provider checks offsetParent !== null)
    attrs: { "data-testid": "send-button" },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    click() { clicks.push(Date.now()); },
    addEventListener() {},
  };
  // getEditor() queries the candidate list with querySelectorAll and validates
  // each hit, so the fake composer must be served through both APIs like a real
  // #prompt-textarea node.
  const isEditorSel = (sel) => String(sel).includes("prompt-textarea");
  const stub = makeStub({
    document: {
      querySelector: (sel) => (isEditorSel(sel) ? editor : sel.includes("composer-submit-button") ? sendBtn : null),
      querySelectorAll: (sel) => (isEditorSel(sel) ? [editor] : []),
      execCommand: (cmd, _ui, val) => {
        if (cmd === "insertText") editor.textContent += val || "";
        else if (cmd === "insertLineBreak") editor.textContent += "\n";
        return true;
      },
    },
    window: { location: { pathname: "/" } },
  });
  const { P, ZS } = loadProvider("chatgpt.js", stub);

  ok("a blank ChatGPT chat is startable (no turns, composer mounted)", P.chatIsEmpty() && P.isFreshChat());
  const ready = await P.ensureComposerReady("startup");
  ok("ChatGPT reports the composer ready without any dashboard check", ready && ready.ready === true);

  const prompt = ZS.buildSystemPrompt([{ name: "execute_luau" }, { name: "script_read" }]);
  ok("the bootstrap prompt carries the ZeroScript system marker", prompt.includes(ZS.SYS_MARKER));

  await P.typeAndSend(prompt);
  ok("the bootstrap prompt is typed into the ChatGPT composer", editor.textContent.includes(ZS.SYS_MARKER));
  ok("the ChatGPT send control is clicked exactly once", clicks.length === 1, `clicks=${clicks.length}`);
  ok("the adapter does not leave the composer locked after sending",
    editor.getAttribute("contenteditable") !== "false");

  // Post-send: a rendered reply must round-trip through the normal reader.
  const md = {
    nodeType: 1, tagName: "DIV", childNodes: [], classList: { contains: () => false },
    getAttribute: () => null, matches: () => false,
    querySelector: () => null, querySelectorAll: () => [],
  };
  md.childNodes = [{ nodeType: 3, nodeValue: "Ready. What are we building?", childNodes: [] }];
  const turn = {
    nodeType: 1, tagName: "DIV", childNodes: [md], classList: { contains: () => false },
    getAttribute: (n) => (n === "data-message-author-role" ? "assistant" : n === "data-message-id" ? "m1" : null),
    matches: () => false,
    querySelector: (sel) => (sel === ".markdown" ? md : null),
    querySelectorAll: (sel) => (sel === ".markdown" ? [md] : []),
  };
  stub.doc.querySelectorAll = () => [turn];
  const reply = P.readAssistant();
  ok("a normal ChatGPT reply is readable by the agent loop",
    reply.present && /Ready\. What are we building\?/.test(reply.reply));
  ok("ChatGPT declares no reasoning selector (nothing extra to parse)",
    typeof P.thinkingSel === "undefined");
})();
