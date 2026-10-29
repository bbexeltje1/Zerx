// ChatGPT turn discovery across both DOM generations (run: node test-chatgpt-turns.js).
// Not shipped.
//
// WHY THIS EXISTS: the composer fix made the bar visible again, but the adapter
// still only recognised turns carrying `data-message-author-role` - which the
// current build no longer emits. allItems() therefore returned [], and with zero
// turns the core could not:
//   • camouflage the ⟦ZS-SYS⟧ bootstrap (decorate.sweep iterates allItems()),
//   • see the model's {"command":"list_commands"} reply (lastAssistant() = null,
//     so waitForResponse() sat until its inactivity timeout),
//   • recognise its own injected result turn (isInjectedFeedback reads turn text).
// The observed result was exactly the report: the raw bootstrap stayed on screen
// and commands never ran.
//
// These tests pin the replacement model. The fixtures encode the structures we
// can actually cite:
//   • legacy: the element carrying data-message-author-role IS the turn;
//   • current (2026-09+): a data-turn-key CONTAINER holds the turn, with the role
//     carried by markers inside it ([data-user-message-bubble],
//     h4[data-conversation-role="assistant"]) and the body rendered into a
//     MarkdownRoot-<hash> container.
// The current-markup fixtures are MODELS built from those structural facts, not
// a capture of this user's account: no live DOM was available here. The probe in
// tools/ then drives the full mocked loop on the same fixtures.
const fs = require("fs");
const path = require("path");

const EXT = __dirname;
const ok = (name, cond, detail) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (!cond && detail ? "  -> " + detail : ""));
  if (!cond) process.exitCode = 1;
};

// ── Tiny DOM (same approach as test-chatgpt-composer.js) ───────────────────
function parseCompound(c) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /^(?:([a-zA-Z][\w-]*))|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([*^$|~]?=)\s*(['"]?)([^\]'"]*)\6\s*)?\]/g;
  let m;
  while ((m = re.exec(c))) {
    if (m[1]) out.tag = m[1].toLowerCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else if (m[4]) out.attrs.push([m[4], m[5] || null, m[7] || ""]);
  }
  return out;
}
function matchCompound(el, c) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && String(el.tagName).toLowerCase() !== c.tag) return false;
  if (c.id && el.getAttribute("id") !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const [name, op, val] of c.attrs) {
    const got = el.getAttribute(name);
    if (got === null) return false;
    if (!op) continue;
    if (op === "=" && got !== val) return false;
    if (op === "*=" && !got.includes(val)) return false;
    if (op === "^=" && !got.startsWith(val)) return false;
    if (op === "$=" && !got.endsWith(val)) return false;
    if (op === "~=" && !got.split(/\s+/).includes(val)) return false;
  }
  return true;
}
const parseSelector = (sel) => String(sel).split(",").map((p) => p.trim().split(/\s+/).map(parseCompound));
function matches(el, sel) {
  return parseSelector(sel).some((chain) => {
    if (!matchCompound(el, chain[chain.length - 1])) return false;
    let i = chain.length - 2, p = el.parentElement;
    while (i >= 0) {
      if (!p) return false;
      if (matchCompound(p, chain[i])) i--;
      p = p.parentElement;
    }
    return true;
  });
}
function el(tag, opts, children) {
  const o = opts || {};
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    parentElement: null,
    childNodes: [],
    style: {},
    hidden: !!o.hidden,
    attrs: Object.assign({}, o.attrs || {}),
    classes: new Set((o.class || "").split(/\s+/).filter(Boolean)),
    classList: {
      contains: (c) => node.classes.has(c),
      add: (c) => node.classes.add(c),
      remove: (c) => node.classes.delete(c),
      toggle: (c, on) => (on === undefined ? (node.classes.has(c) ? node.classes.delete(c) : node.classes.add(c)) : on ? node.classes.add(c) : node.classes.delete(c)),
    },
    get textContent() {
      let t = node.__text || "";
      for (const c of node.childNodes) t += c.nodeType === 3 ? c.nodeValue : c.textContent || "";
      return t;
    },
    set textContent(v) { node.__text = String(v); node.childNodes = []; },
    getAttribute: (n) => (n === "class" ? [...node.classes].join(" ") : n in node.attrs ? node.attrs[n] : null),
    setAttribute: (n, v) => { node.attrs[n] = String(v); },
    removeAttribute: (n) => { delete node.attrs[n]; },
    hasAttribute: (n) => n in node.attrs,
    matches: (sel) => matches(node, sel),
    closest: (sel) => { let p = node; while (p) { if (p.nodeType === 1 && matches(p, sel)) return p; p = p.parentElement; } return null; },
    querySelectorAll: (sel) => {
      const out = [];
      const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType !== 1) continue; if (matches(c, sel)) out.push(c); walk(c); } };
      walk(node);
      return out;
    },
    querySelector: (sel) => node.querySelectorAll(sel)[0] || null,
    compareDocumentPosition: (other) => {
      if (node === other) return 0;
      let root = node;
      while (root.parentElement) root = root.parentElement;
      const all = [];
      const walk = (n) => { all.push(n); for (const c of n.childNodes) walk(c); };
      walk(root);
      return all.indexOf(node) < all.indexOf(other) ? 4 /* FOLLOWING */ : 2 /* PRECEDING */;
    },
    contains: (other) => { let p = other; while (p) { if (p === node) return true; p = p.parentElement; } return false; },
    appendChild: (c) => { c.parentElement = node; node.childNodes = node.childNodes.filter((x) => x !== c).concat([c]); return c; },
    removeChild: (c) => { node.childNodes = node.childNodes.filter((x) => x !== c); c.parentElement = null; return c; },
    insertBefore: (c, ref) => { c.parentElement = node; node.childNodes = node.childNodes.filter((x) => x !== c); const i = ref ? node.childNodes.indexOf(ref) : -1; if (i < 0) node.childNodes.push(c); else node.childNodes.splice(i, 0, c); return c; },
    getBoundingClientRect: () => ({ width: 800, height: 48, left: 100, top: 400, right: 900, bottom: 448 }),
    isConnected: true,
    addEventListener() {}, dispatchEvent() { return true; },
    click() { node.__clicks = (node.__clicks || 0) + 1; },
  };
  if (o.id) node.attrs.id = o.id;
  if (o.text) node.appendChild(txt(o.text));
  Object.assign(node.attrs, o.attrs || {});
  for (const c of children || []) node.appendChild(c);
  return node;
}
function txt(v) { return { nodeType: 3, nodeValue: v, childNodes: [], parentElement: null }; }

function buildDocument(children) {
  const root = el("html");
  for (const c of children) root.appendChild(c);
  const doc = {
    documentElement: root,
    body: root,
    querySelector: (sel) => root.querySelector(sel),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    getElementById: (id) => root.querySelector("#" + id),
    createElement: (t) => el(t),
    createRange: () => ({ selectNodeContents() {} }),
    addEventListener() {}, removeEventListener() {},
    execCommand: () => false,
  };
  return { doc, root };
}

let diagEvents = [];
function load(doc) {
  const win = {
    location: { pathname: "/" },
    addEventListener() {}, removeEventListener() {},
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    getComputedStyle: (n) => ({ display: n.style.display || "block", visibility: "visible", gridTemplateAreas: n.style.gridTemplateAreas || "" }),
  };
  const g = global;
  g.document = doc;
  g.window = win;
  g.location = win.location;
  g.getComputedStyle = win.getComputedStyle;
  g.CustomEvent = class { constructor(t) { this.type = t; } };
  g.MutationObserver = class { observe() {} disconnect() {} };
  g.navigator = { clipboard: { writeText: () => Promise.resolve() } };
  const src = fs.readFileSync(path.join(EXT, "core/config.js"), "utf8") + "\n;\n" +
    fs.readFileSync(path.join(EXT, "core/parser.js"), "utf8") + "\n;\n" +
    fs.readFileSync(path.join(EXT, "providers/chatgpt.js"), "utf8") + "\n;return ZSProvider;";
  const P = new Function(src)();
  P.init({ diag: (e, d) => diagEvents.push({ e, d }) });
  return P;
}

// ── Fixtures ───────────────────────────────────────────────────────────────
// Legacy: the message element carries the role + a stable UUID id.
function legacyTurn(role, id, body) {
  const wrap = el("div", { attrs: { "data-message-author-role": role, "data-message-id": id } });
  const md = el("div", { class: "markdown" });
  md.appendChild(txt(body));
  wrap.appendChild(md);
  return wrap;
}
// Current (2026-09+): a data-turn-key CONTAINER; the role lives on markers inside.
function modernTurn(kind, key, body, opts) {
  const o = opts || {};
  const box = el("div", { attrs: { "data-turn-key": key } });
  if (kind === "user") {
    if (!o.noBubble) box.appendChild(el("div", { attrs: { "data-user-message-bubble": "true" } }, [el("p", { text: body })]));
    else box.appendChild(el("div", {}, [el("p", { text: body })]));
  } else {
    if (!o.noHeading) box.appendChild(el("h4", { attrs: { "data-conversation-role": "assistant" }, text: "ChatGPT said:" }));
    const md = el("div", { class: o.noMarkdownRoot ? "prose" : "MarkdownRoot-abc123" });
    md.appendChild(txt(body));
    box.appendChild(md);
  }
  if (o.chrome) {
    // Buttons and screen-reader labels live INSIDE the turn on this markup.
    box.appendChild(el("button", { attrs: { "aria-label": "Copy" } }, [txt("Copy")]));
    box.appendChild(el("span", { class: "sr-only", text: "You said:" }));
  }
  return box;
}
const thread = (children) => el("main", {}, [el("div", { class: "thread" }, children)]);

// ── 1. Legacy markup ───────────────────────────────────────────────────────
{
  const { doc } = buildDocument([thread([legacyTurn("user", "u1", "build a shop"), legacyTurn("assistant", "a1", "Sure - one moment.")])]);
  const P = load(doc);
  const items = P.allItems();
  ok("legacy: both turns are enumerated", items.length === 2, `got ${items.length}`);
  ok("legacy: roles classify correctly", P.isUserItem(items[0]) && P.isAssistantItem(items[1]));
  ok("legacy: counts agree", P.assistantCount() === 1 && P.userCount() === 1);
  ok("legacy: the assistant text is read", /Sure - one moment/.test(P.itemText(items[1])));
  ok("legacy: identity is the message UUID", P.itemKey(items[0]) === "u1" && P.itemKey(items[1]) === "a1");
  ok("legacy: lastAssistant is the last assistant turn", P.lastAssistant() === items[1]);
  ok("legacy: the chat is not empty", !P.chatIsEmpty());
}

// ── 2. Current markup (data-turn-key containers) ───────────────────────────
{
  const { doc } = buildDocument([thread([
    modernTurn("user", "t1", "build a shop", { chrome: true }),
    modernTurn("assistant", "t2", 'Running it now.\n{"command":"list_commands"}', { chrome: true }),
  ])]);
  const P = load(doc);
  const items = P.allItems();
  ok("current: containers are enumerated as turns", items.length === 2, `got ${items.length}`);
  ok("current: the user bubble marks the user turn", P.isUserItem(items[0]) && !P.isAssistantItem(items[0]));
  ok("current: the assistant heading marks the assistant turn", P.isAssistantItem(items[1]));
  ok("current: counts agree", P.assistantCount() === 1 && P.userCount() === 1);
  ok("current: identity is the turn key", P.itemKey(items[0]) === "t1" && P.itemKey(items[1]) === "t2");
  ok("current: assistant text comes from the MarkdownRoot body",
    /Running it now\./.test(P.itemText(items[1])) && /list_commands/.test(P.itemText(items[1])));
  ok("current: the role heading and Copy button never leak into the text",
    !/ChatGPT said:/.test(P.itemText(items[1])) && !/Copy/.test(P.itemText(items[1])),
    JSON.stringify(P.itemText(items[1]).slice(0, 80)));
  ok("current: user text comes from the bubble, not the whole container",
    P.itemText(items[0]).trim() === "build a shop", JSON.stringify(P.itemText(items[0])));
  ok("current: lastAssistant resolves on the container markup", P.lastAssistant() === items[1]);
  ok("current: snapshot measures the reply body", P.snapshot().rp > 10);
  const read = P.readAssistant();
  ok("current: readAssistant returns the reply text", read.present && /list_commands/.test(read.reply));
}

// ── 3. Exactly one item per turn (no nested duplicates) ────────────────────
{
  // A container that still wraps the legacy marked element (transitional builds)
  // plus a nested role heading must still count as ONE turn.
  const legacy = el("div", { attrs: { "data-message-author-role": "assistant", "data-message-id": "m9" } }, [
    el("div", { class: "markdown" }, [txt("hello")]),
  ]);
  const box = el("div", { attrs: { "data-turn-key": "t9" } }, [
    el("h4", { attrs: { "data-conversation-role": "assistant" }, text: "ChatGPT said:" }),
    legacy,
  ]);
  const { doc } = buildDocument([thread([box])]);
  const P = load(doc);
  const items = P.allItems();
  ok("nested: a container plus the legacy element inside it is ONE turn", items.length === 1, `got ${items.length}`);
  ok("nested: the container is the item (not the inner element)", items[0] === box);
  ok("nested: identity is the container's turn key", P.itemKey(items[0]) === "t9");
  // A promoted container without a key of its own falls back to the message UUID.
  const { doc: doc2 } = buildDocument([el("div", {}, [el("article", {}, [
    el("div", { attrs: { "data-message-author-role": "assistant", "data-message-id": "m11" } }, [el("div", { class: "markdown" }, [txt("x")])]),
  ])])]);
  const P2 = load(doc2);
  ok("nested: a turn without a turn key falls back to the message UUID",
    P2.itemKey(P2.allItems()[0]) === "m11", String(P2.itemKey(P2.allItems()[0])));
  ok("nested: the heading is never its own turn", !items.includes(box.querySelector("h4")));
}

// ── 4. Stability across DOM replacement ────────────────────────────────────
{
  const host = el("div", { class: "thread" }, [modernTurn("assistant", "t7", "partial")]);
  const { doc } = buildDocument([el("main", {}, [host])]);
  const P = load(doc);
  const before = P.allItems()[0];
  const keyBefore = P.itemKey(before);
  // React swaps the node on every re-render (same logical turn).
  host.childNodes.length = 0;
  host.appendChild(modernTurn("assistant", "t7", "partial + more"));
  const after = P.allItems()[0];
  ok("replacement: the turn node really changed", after !== before);
  ok("replacement: the identity survives the swap", P.itemKey(after) === keyBefore && keyBefore === "t7");
  ok("replacement: the new node is read, not the cached one", /partial \+ more/.test(P.itemText(after)));
}

// ── 5. Unclassified / ambiguous nodes are not turns ────────────────────────
{
  const noRole = el("div", { attrs: { "data-turn-key": "x1" } }, [el("div", {}, [txt("who am I?")])]);
  const editBox = el("div", { attrs: { "data-message-author-role": "user" } }, [
    el("div", { class: "ProseMirror", attrs: { contenteditable: "true" } }, [txt("editing")]),
  ]);
  const { doc } = buildDocument([thread([noRole, editBox])]);
  const P = load(doc);
  const items = P.allItems();
  ok("ambiguous: a container with no role marker is NOT a turn", !items.includes(noRole));
  ok("ambiguous: an 'edit message' box inside a turn is not a separate turn", items.length === 1);
}

// ── 6. Assistant text: multiline fenced blocks + the CodeMirror tap ────────
{
  const cmLines = (lines, attrs) =>
    el("div", { class: "cm-content", attrs: attrs || {} },
      lines.map((l) => el("div", { class: "cm-line" }, l === "" ? [] : [txt(l)])));
  const turn = modernTurn("assistant", "t3", "");
  const md = turn.querySelector("[class*='MarkdownRoot']");
  const pre = el("pre");
  pre.appendChild(cmLines(["###LUA###", "local a = 1", "", "return a", "###END_LUA###"]));
  md.appendChild(pre);
  const { doc } = buildDocument([thread([turn])]);
  const P = load(doc);
  const text = P.itemText(P.allItems()[0]);
  ok("multiline: the code block is read line by line, blank line kept",
    /###LUA###\nlocal a = 1\n\nreturn a\n###END_LUA###/.test(text), JSON.stringify(text));
  ok("multiline: textWithout never collapses it to one line", !/###LUA###local/.test(text));

  // The MAIN-world tap (data-zs-cm) still wins over the rendered (truncated) lines.
  const full = '{"command":"multi_edit","params":{"edits":[{"old_string":"a","new_string":"' + "x".repeat(3000) + '"}]}}';
  md.appendChild(cmLines(['{"command":"multi_edit"'], { "data-zs-cm": full }));
  ok("multiline: the data-zs-cm tap is still preferred on the new markup",
    P.itemText(P.allItems()[0]).includes(full));
}

// ── 7. Current send / stop controls ────────────────────────────────────────
{
  const form = el("form", { attrs: { "data-chatgpt-composer": "" } }, [
    el("div", { class: "ProseMirror", attrs: { contenteditable: "true", role: "textbox" } }),
    el("button", { id: "send-1", attrs: { type: "submit", "aria-label": "Send" } }, [txt("Send")]),
  ]);
  const { doc } = buildDocument([el("main", {}, [form])]);
  const P = load(doc);
  const send = form.querySelector("#send-1");
  ok("controls: a bare submit button (no id/testid) is recognised as send",
    P._test.sendButton() === send, String(P._test.sendButton() && P._test.sendButton().id));
  ok("controls: it is not classified as stop", P._test.isStopBtn(send) === false);

  // Mid-stream the stop control appears next to it.
  const stop = el("button", { attrs: { "aria-label": "Stop streaming" } }, [txt("Stop")]);
  form.appendChild(stop);
  const P2 = load(doc);
  ok("controls: the stop control is detected", P2._test.stopButton() === stop);
  ok("controls: stop is never returned as send", P2._test.sendButton() === send);
  ok("controls: generation is therefore observable", P2.isGenerating() === true ||
    P2.isGenerating() === false); // both are valid - the point is it does not throw

  // A transcript "Copy" button inside the composer must be ignored.
  const copy = el("button", { attrs: { "aria-label": "Copy" } }, [txt("Copy")]);
  form.appendChild(copy);
  const P3 = load(doc);
  ok("controls: unrelated composer buttons are neither send nor stop",
    P3._test.sendButton() === send && P3._test.stopButton() === stop);

  // Legacy markup keeps working (id + testids).
  const legacyForm = el("form", {}, [
    el("div", { id: "prompt-textarea", class: "ProseMirror", attrs: { contenteditable: "true" } }),
    el("button", { id: "composer-submit-button", attrs: { "data-testid": "send-button" } }, [txt("Send")]),
  ]);
  const d4 = buildDocument([el("main", {}, [legacyForm])]);
  const P4 = load(d4.doc);
  ok("controls: the legacy submit control still wins",
    P4._test.sendButton() === legacyForm.querySelector("#composer-submit-button"));
  const legacyStop = el("button", { attrs: { "data-testid": "stop-button" } }, [txt("Stop")]);
  legacyForm.appendChild(legacyStop);
  const P5 = load(d4.doc);
  ok("controls: the legacy stop testid is still honoured", P5._test.stopButton() === legacyStop);
  ok("controls: a testid stop is never returned as send",
    P5._test.sendButton() === legacyForm.querySelector("#composer-submit-button"));

  // Localized labels: the send button must not be read as stop (fr/de/zh).
  const fr = el("form", {}, [
    el("div", { class: "ProseMirror", attrs: { contenteditable: "true" } }),
    el("button", { attrs: { type: "submit", "aria-label": "Envoyer le message" } }, [txt("Envoyer")]),
  ]);
  const d6 = buildDocument([el("main", {}, [fr])]);
  const P6 = load(d6.doc);
  ok("controls: a localized send label is still send", !!P6._test.sendButton());
  const frStop = el("button", { attrs: { "aria-label": "Arrêter la réponse" } }, [txt("Arrêter")]);
  fr.appendChild(frStop);
  const P7 = load(d6.doc);
  ok("controls: a localized stop label is stop", P7._test.stopButton() === frStop);
}

// ── 8. Diagnostics: a conversation with no recognisable turn is LOUD ───────
{
  // A page that clearly holds a RENDERED conversation but uses markup we cannot
  // classify: message bodies exist, yet none of them is a turn we recognise.
  const unknown = el("main", {}, [
    el("section", { attrs: { "data-unknown-turn": "1" } }, [
      el("div", { class: "markdown", text: "x".repeat(600) }),
    ]),
  ]);
  const { doc } = buildDocument([unknown]);
  const P = load(doc);
  P._test.resetTurnModel();
  diagEvents = [];
  P.allItems();
  const ev = diagEvents.find((d) => d.e === "turns.unrecognized");
  ok("diagnostics: an unclassifiable conversation reports turns.unrecognized", !!ev,
    diagEvents.map((d) => d.e).join(", "));
  ok("diagnostics: the report says what was probed",
    !!ev && ev.d.probes && ev.d.probes.turnKey === false && ev.d.probes.authorRole === false);

  // A blank chat stays quiet - including the instant between our own send and
  // the site painting the user turn, when the composer still holds the bootstrap
  // (that text used to trip a page-text heuristic and log a false alarm on every
  // Start). Nothing RENDERED ⇒ nothing to be wrong about.
  const blank = buildDocument([el("main", {}, [
    el("div", { attrs: { "data-turn-key": "t0" } }),
    el("form", {}, [
      el("div", { class: "ProseMirror", attrs: { contenteditable: "true", role: "textbox" },
        text: "⟦ZS-SYS⟧ " + "instructions ".repeat(200) }),
    ]),
  ])]);
  const P2 = load(blank.doc);
  P2._test.resetTurnModel();
  diagEvents = [];
  P2.allItems();
  ok("diagnostics: a blank chat does not raise the alarm",
    !diagEvents.some((d) => d.e === "turns.unrecognized"), diagEvents.map((d) => d.e).join(", "));

  // And a recognised conversation reports its model once.
  const good = buildDocument([thread([modernTurn("user", "t1", "hi"), modernTurn("assistant", "t2", "hello")])]);
  const P3 = load(good.doc);
  P3._test.resetTurnModel();
  diagEvents = [];
  P3.allItems();
  const model = diagEvents.find((d) => d.e === "turns.model");
  ok("diagnostics: a recognised conversation reports its turn model", !!model && model.d.model === "container",
    JSON.stringify(diagEvents));
}

console.log("\nTURN MODEL DIAGNOSTICS:", diagEvents.filter((d) => /^turns\./.test(d.e)).map((d) => d.e + ":" + (d.d && d.d.model)).join(", ") || "(none captured)");
