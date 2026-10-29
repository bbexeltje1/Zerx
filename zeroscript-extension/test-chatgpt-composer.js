// ChatGPT composer detection (run: node test-chatgpt-composer.js). Not shipped.
//
// WHY THIS EXISTS: on 2026-10-29 the live Extension showed a bar whose Start
// button was correct, present and enabled - and completely invisible: `#zs-bar`
// carried an inline `display: none` and a 0x0 rect, while
// `document.querySelector("#prompt-textarea")` returned null. The composer had
// lost that id in ChatGPT's 2026-09 "Chat / Work" redesign (the editor is now a
// ProseMirror `div[contenteditable][role=textbox]` inside the composer form), so
// getEditor() returned null, barMount() had nothing to mount into, and the core's
// positional fallback had no frame to place the bar against - so it hid it.
//
// These tests pin the detector that fixes it:
//   • the legacy #prompt-textarea still works;
//   • the current ProseMirror composer is found (form-scoped, and marked);
//   • a composer that mounts AFTER page init is picked up on the next query
//     (no caching - the core re-queries every animation frame);
//   • nothing else is ever mistaken for the composer (stray contenteditable,
//     transcript "edit message" editors, hidden/aria-hidden editors);
//   • barMount() refuses an unsafe grid instead of collapsing the composer.
//
// The stub below is a tiny DOM: it implements node lookup, `closest` and
// `getComputedStyle` for exactly the selectors the provider uses. Which element
// IS the composer is decided by the provider code under test, never by the stub.
const fs = require("fs");
const path = require("path");

const EXT = __dirname;
const ok = (name, cond, detail) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (!cond && detail ? "  -> " + detail : ""));
  if (!cond) process.exitCode = 1;
};

// ── Minimal DOM ─────────────────────────────────────────────────────────────
// Selector support: comma lists of compound selectors (`div.ProseMirror[role='textbox']`,
// `#prompt-textarea`, `[data-chatgpt-composer]`), with an optional descendant
// combinator between two compounds. That is all EDITOR_CANDIDATES and the
// provider's closest() calls use.
function parseCompound(c) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /^(?:([a-zA-Z][\w-]*))|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([*^$|~]?=)\s*(['"]?)([^\]'"]*)\6\s*)?\]/g;
  let m;
  while ((m = re.exec(c))) {
    if (m[1]) out.tag = m[1].toLowerCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else if (m[4]) out.attrs.push([m[4], m[5] || null, m[6] || null, m[7] || ""]);
  }
  return out;
}
function matchCompound(el, c) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && String(el.tagName).toLowerCase() !== c.tag) return false;
  if (c.id && el.getAttribute("id") !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const [name, op, , val] of c.attrs) {
    const got = el.getAttribute(name);
    if (got === null) return false;
    if (!op) continue; // presence only: [data-chatgpt-composer]
    if (op === "=" && got !== val) return false;
    if (op === "*=" && !got.includes(val)) return false;
    if (op === "^=" && !got.startsWith(val)) return false;
    if (op === "$=" && !got.endsWith(val)) return false;
    if (op === "~=" && !got.split(/\s+/).includes(val)) return false;
    if (op === "|=" && !(got === val || got.startsWith(val + "-"))) return false;
  }
  return true;
}
function parseSelector(sel) {
  return String(sel).split(",").map((part) =>
    part.trim().split(/\s+/).map(parseCompound));
}
function matches(el, sel) {
  return parseSelector(sel).some((chain) => {
    if (!matchCompound(el, chain[chain.length - 1])) return false;
    let i = chain.length - 2;
    let p = el.parentElement;
    while (i >= 0) {
      if (!p) return false;
      if (matchCompound(p, chain[i])) i--;
      p = p.parentElement;
    }
    return true;
  });
}

let uid = 0;
function el(tag, opts, children) {
  const o = opts || {};
  const node = {
    __id: ++uid,
    nodeType: 1,
    tagName: tag.toUpperCase(),
    parentElement: null,
    childNodes: [],
    owned: [],
    style: {},
    hidden: !!o.hidden,
    attrs: {},
    classes: new Set((o.class || "").split(/\s+/).filter(Boolean)),
    textContent: o.text || "",
    classList: {
      contains: (c) => node.classes.has(c),
      add: (c) => node.classes.add(c),
      remove: (c) => node.classes.delete(c),
      toggle: (c, on) => (on === undefined ? (node.classes.has(c) ? node.classes.delete(c) : node.classes.add(c)) : on ? node.classes.add(c) : node.classes.delete(c)),
    },
    getAttribute: (n) => (n === "class" ? [...node.classes].join(" ") : n in node.attrs ? node.attrs[n] : n === "id" && o.id ? o.id : null),
    setAttribute: (n, v) => { node.attrs[n] = String(v); },
    removeAttribute: (n) => { delete node.attrs[n]; },
    hasAttribute: (n) => n in node.attrs,
    matches: (sel) => matches(node, sel),
    closest: (sel) => {
      let p = node;
      while (p) { if (p.nodeType === 1 && matches(p, sel)) return p; p = p.parentElement; }
      return null;
    },
    querySelectorAll: (sel) => {
      const out = [];
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (c.nodeType !== 1) continue;
          if (matches(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(node);
      return out;
    },
    querySelector: (sel) => node.querySelectorAll(sel)[0] || null,
    getBoundingClientRect: () => ({ width: 800, height: 48, left: 100, top: 400, right: 900, bottom: 448 }),
    isConnected: true,
    contains: (other) => {
      let p = other;
      while (p) { if (p === node) return true; p = p.parentElement; }
      return false;
    },
    appendChild: (c) => {
      c.parentElement = node;
      node.childNodes = node.childNodes.filter((x) => x !== c).concat([c]);
      return c;
    },
    removeChild: (c) => {
      node.childNodes = node.childNodes.filter((x) => x !== c);
      c.parentElement = null;
      return c;
    },
    insertBefore: (c, ref) => {
      c.parentElement = node;
      const i = ref ? node.childNodes.indexOf(ref) : -1;
      node.childNodes = node.childNodes.filter((x) => x !== c);
      if (i < 0) node.childNodes.push(c);
      else node.childNodes.splice(node.childNodes.indexOf(ref), 0, c);
      return c;
    },
    get firstElementChild() { return node.childNodes.find((c) => c.nodeType === 1) || null; },
    get nextElementSibling() {
      const p = node.parentElement;
      if (!p) return null;
      const i = p.childNodes.indexOf(node);
      for (let j = i + 1; j < p.childNodes.length; j++) if (p.childNodes[j].nodeType === 1) return p.childNodes[j];
      return null;
    },
    addEventListener() {},
    dispatchEvent() { return true; },
    __clicks: 0,
    click() { node.__clicks++; if (node.__onClick) node.__onClick(); },
    focused: false,
    focus() { node.focused = true; },
  };
  if (o.id) node.attrs.id = o.id;
  Object.assign(node.attrs, o.attrs || {});
  for (const c of children || []) node.appendChild(c);
  return node;
}

function buildDocument(html) {
  // html: array of top-level nodes created with el(); a fake <html> root wraps
  // them so closest()/querySelectorAll() behave like the real document.
  const root = el("html");
  for (const n of html) root.appendChild(n);
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

// Load config + parser + the provider against a fresh stub DOM.
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
  return new Function(src)();
}

// Fixture builders -----------------------------------------------------------------
const legacyComposer = () =>
  el("form", {}, [
    el("div", { class: "prosemirror-parent", attrs: { "data-testid": "composer" } }, [
      el("div", { id: "prompt-textarea", class: "ProseMirror", attrs: { contenteditable: "true" } }),
    ]),
    el("button", { id: "composer-submit-button", attrs: { "data-testid": "send-button" } }, ["Send"]),
  ]);

// The 2026-09 signed-in shell: no id, no composer-surface, the editor is a
// ProseMirror textbox inside the composer form.
const modernComposer = (opts) => {
  const o = opts || {};
  return el("form", o.marked ? { attrs: { "data-chatgpt-composer": "" } } : {}, [
    el("div", { class: "relative flex w-full" }, [
      el("div", {
        class: "ProseMirror",
        attrs: Object.assign({ contenteditable: "true" }, o.role === false ? {} : { role: "textbox" }),
      }),
    ]),
    // The current build's send control: no id, no testid - just a submit button.
    el("button", { attrs: { type: "submit", "aria-label": "Send" } }, ["Send"]),
  ]);
};

// ── 1. Legacy selector ─────────────────────────────────────────────────────
{
  const { doc, root } = buildDocument([el("main", {}, [legacyComposer()])]);
  const P = load(doc);
  const ed = P.getEditor();
  ok("legacy #prompt-textarea is found", !!ed && ed.getAttribute("id") === "prompt-textarea");
  ok("legacy composer reports a usable frame", !!P.composerFrame());
  ok("legacy blank chat is startable", P.chatIsEmpty() && P.isFreshChat());
  ok("editorText reads the legacy composer", P.editorText() === "");
  root.appendChild(el("div")); // keep the fixture alive
}

// ── 2. The current ProseMirror composer ────────────────────────────────────
{
  // 2a. bare <form> wrapper, role="textbox" (measured on 2026-09/10 builds)
  {
    const { doc } = buildDocument([el("main", {}, [modernComposer()])]);
    const P = load(doc);
    const ed = P.getEditor();
    ok("current ProseMirror textbox in a plain form is found",
      !!ed && ed.classList.contains("ProseMirror"));
    ok("the detected editor has no #prompt-textarea id", !!ed && ed.getAttribute("id") === null);
    ok("composerFrame() resolves the composer form",
      !!P.composerFrame() && P.composerFrame().tagName === "FORM");
    ok("a blank chat with the current composer is startable", P.isFreshChat());
  }
  // 2b. form[data-chatgpt-composer] marker
  {
    const { doc } = buildDocument([el("main", {}, [modernComposer({ marked: true })])]);
    const P = load(doc);
    ok("form[data-chatgpt-composer] composer is found", !!P.getEditor());
  }
  // 2c. marker on a non-form wrapper, editor without role
  {
    const { doc } = buildDocument([el("div", { attrs: { "data-chatgpt-composer": "" } },
      [el("div", { class: "ProseMirror", attrs: { contenteditable: "true" } })])]);
    const P = load(doc);
    ok("a marked composer wrapper without a <form> is found", !!P.getEditor());
  }
}

// ── 3. The composer that mounts after page init ─────────────────────────────
{
  const shell = el("main", {}, [el("div", { class: "loading" })]);
  const { doc } = buildDocument([shell]);
  const P = load(doc);
  ok("no editor is reported before the composer mounts", P.getEditor() === null);
  ok("chatIsEmpty still holds on the empty shell", P.chatIsEmpty());
  // React mounts the composer a moment later (the real cold-load case).
  shell.appendChild(modernComposer());
  const ed = P.getEditor();
  ok("the late-mounted composer is picked up on the next query (no caching)", !!ed);
  ok("a late-mounted composer makes the chat startable", P.isFreshChat());
  ok("repeated queries keep returning the same live editor", P.getEditor() === ed);
}

// ── 4. Never mistake anything else for the composer ────────────────────────
{
  // (a) unrelated contenteditable outside any composer form (sidebar rename box)
  const stray = el("div", { class: "sidebar-rename", attrs: { contenteditable: "true", role: "textbox" } });
  {
    const { doc } = buildDocument([el("aside", {}, [stray])]);
    const P = load(doc);
    ok("a stray contenteditable outside the composer is NOT the editor", P.getEditor() === null);
    ok("…so the chat is not treated as startable", P.isFreshChat() === false);
  }
  // (b) a transcript "edit message" ProseMirror inside a turn - even in a form
  {
    const turnEditor = el("div", { class: "ProseMirror", attrs: { contenteditable: "true", role: "textbox" } });
    const turn = el("div", { attrs: { "data-message-author-role": "user" } }, [turnEditor]);
    const { doc } = buildDocument([el("form", {}, [el("div", {}, [turn])])]);
    const P = load(doc);
    ok("a transcript editor inside a message turn is NOT the composer", P.getEditor() === null);
    const turn2Editor = el("div", { class: "ProseMirror", attrs: { contenteditable: "true" } });
    const turn2 = el("div", { attrs: { "data-turn-key": "t1" } }, [turn2Editor]);
    const d2 = buildDocument([el("form", {}, [turn2])]);
    ok("a transcript editor inside a 2026-09 turn is NOT the composer", load(d2.doc).getEditor() === null);
  }
  // (c) a hidden composer (aria-hidden / display:none) - e.g. behind a modal
  {
    const hidden = el("form", {}, [
      el("div", { class: "ProseMirror", attrs: { contenteditable: "true", role: "textbox", "aria-hidden": "true" } }),
    ]);
    const d1 = buildDocument([hidden]);
    ok("an aria-hidden composer is not treated as available", load(d1.doc).getEditor() === null);
    const gone = el("form", {}, [
      el("div", { class: "ProseMirror", attrs: { contenteditable: "true", role: "textbox" } }),
    ]);
    gone.childNodes[0].style.display = "none";
    const d2 = buildDocument([gone]);
    ok("a display:none composer is not treated as available", load(d2.doc).getEditor() === null);
  }
  // (d) an editable that is neither ProseMirror nor a textbox role
  {
    const weird = el("form", {}, [el("div", { attrs: { contenteditable: "true" } })]);
    const { doc } = buildDocument([weird]);
    ok("a bare contenteditable div in a form is not assumed to be the composer", load(doc).getEditor() === null);
  }
  // (e) a page-controlled contenteditable=false must never match...
  {
    const ro = el("form", {}, [el("div", { class: "ProseMirror", attrs: { contenteditable: "false", role: "textbox" } })]);
    const { doc } = buildDocument([ro]);
    ok("contenteditable=false is never the composer", load(doc).getEditor() === null);
  }
  // ...but OUR OWN input lock (contenteditable=false + data-zs-locked) must still
  // be recognised: startSession() locks the composer and then calls
  // ensureComposerReady(), which asks for the editor.
  {
    const locked = el("form", {}, [el("div", {
      class: "ProseMirror",
      attrs: { contenteditable: "false", role: "textbox", "data-zs-locked": "1" },
    })]);
    const { doc } = buildDocument([locked]);
    const P = load(doc);
    ok("a composer locked by ZeroScript is still detected (startup lock)",
      !!P.getEditor(), "getEditor() returned null while locked");
    P.setInputLock(false);
    ok("unlocking restores a normal, editable composer",
      P.getEditor().getAttribute("contenteditable") === "true");
  }
}

// ── 5. barMount() refuses an unsafe grid ───────────────────────────────────
{
  // A composer-surface grid with a full-width top row -> safe inline mount.
  const safeBox = el("div", { class: "composer-surface-primary" }, [
    el("div", { class: "prosemirror-parent" }, [
      el("div", { id: "prompt-textarea", class: "ProseMirror", attrs: { contenteditable: "true" } }),
    ]),
  ]);
  safeBox.style.gridTemplateAreas = '"eyebrow" "controls" "body"';
  const d1 = buildDocument([el("main", {}, [safeBox])]);
  const P1 = load(d1.doc);
  const mount1 = P1.barMount();
  ok("a grid with a full-width top row is a safe inline mount",
    !!mount1 && mount1.parent === safeBox);

  // The same surface WITHOUT such a row: inserting there would auto-place the bar
  // into a cell and collapse the editor (measured live 2026-09). Must be refused.
  const unsafeBox = el("div", { class: "composer-surface-primary" }, [
    el("div", { class: "prosemirror-parent" }, [
      el("div", { id: "prompt-textarea", class: "ProseMirror", attrs: { contenteditable: "true" } }),
    ]),
  ]);
  unsafeBox.style.gridTemplateAreas = '"leading primary trailing"';
  const d2 = buildDocument([el("main", {}, [unsafeBox])]);
  const P2 = load(d2.doc);
  ok("a grid with no safe top row is REFUSED (core falls back to floating)",
    P2.barMount() === null);
  ok("…and the editor is still found, so the bar can float above it",
    !!P2.getEditor() && !!P2.composerFrame());

  // No grid template at all.
  const plainBox = el("div", { class: "composer-surface-primary" }, [
    el("div", { id: "prompt-textarea", class: "ProseMirror", attrs: { contenteditable: "true" } }),
  ]);
  const d3 = buildDocument([el("main", {}, [plainBox])]);
  ok("a composer surface without a grid template is refused",
    load(d3.doc).barMount() === null);

  // The 2026-09 shell has no composer-surface at all -> floating fallback.
  const d4 = buildDocument([el("main", {}, [modernComposer()])]);
  ok("the current shell requests no inline mount (floating fallback)",
    load(d4.doc).barMount() === null);
}

// ── 6. The composer stays typed-into on both shells ───────────────────────
(async () => {
  for (const [label, factory] of [["legacy", legacyComposer], ["current", modernComposer]]) {
    const { doc } = buildDocument([el("main", {}, [factory()])]);
    const P = load(doc);
    const clicks = [];
    const ed = P.getEditor();
    doc.execCommand = (cmd, _ui, val) => {
      if (cmd === "insertText") ed.textContent += val || "";
      else if (cmd === "insertLineBreak") ed.textContent += "\n";
      return true;
    };
    const btn = doc.querySelector("#composer-submit-button, button[type='submit']");
    await P.typeAndSend("###LUA###\nreturn 1\n###END_LUA###");
    ok(`${label}: the composer receives the injected text`, /###LUA###/.test(ed.textContent));
    ok(`${label}: the send control is clicked once`, !!btn && btn.__clicks === 1,
      `clicks=${btn ? btn.__clicks : "no button"}`);
  }
})();
