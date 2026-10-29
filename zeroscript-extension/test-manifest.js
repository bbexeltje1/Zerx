// Manifest + script-order validation (run: node test-manifest.js). Not shipped.
//
// Why this exists: the extension is a handful of plain <script> files per site,
// loaded in ONE shared scope, with no bundler and no imports. Order is
// load-bearing - core/config.js and core/parser.js define the consts the
// provider and core/main.js close over, and core/main.js throws if ZSProvider is
// missing. A provider that is registered in the wrong place (or a dashboard-only
// script sneaking into the standalone path) therefore breaks the agent BEFORE any
// UI exists, with no bar and no explanation. This test is the guard for that:
//
//   1. every AI site entry loads config -> parser -> provider -> main, in order;
//   2. every file the manifest names exists on disk;
//   3. host_permissions, background PROVIDER_URLS, popup SUPPORTED_HOSTS and
//      core/main.js AI_SITES all agree (a missing host silently kills a site);
//   4. nothing dashboard-specific is loaded into the standalone extension.
const fs = require("fs");
const path = require("path");

const EXT = __dirname;
const read = (rel) => fs.readFileSync(path.join(EXT, rel), "utf8");
const ok = (name, cond, detail) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (!cond && detail ? "  -> " + detail : ""));
  if (!cond) process.exitCode = 1;
};

let manifest;
try {
  manifest = JSON.parse(read("manifest.json"));
} catch (e) {
  ok("manifest.json parses as JSON", false, e.message);
  process.exit(1);
}
ok("manifest.json parses as JSON", true);

// ── Shape ──────────────────────────────────────────────────────────────────
ok("Manifest V3", manifest.manifest_version === 3);
ok("has a name and a semver-ish version",
  !!manifest.name && /^\d+\.\d+\.\d+$/.test(manifest.version || ""));
ok("permissions are storage-only (no new privileges for the agent)",
  JSON.stringify(manifest.permissions) === JSON.stringify(["storage"]));
ok("a background service worker is registered",
  manifest.background && manifest.background.service_worker === "background.js");
ok("the toolbar action opens the popup", manifest.action && manifest.action.default_popup === "popup.html");

// ── Hosts ──────────────────────────────────────────────────────────────────
const hosts = manifest.host_permissions || [];
const hostSet = new Set(hosts.map((h) => h.replace(/^[a-z]+:\/\//, "").replace(/\/\*$/, "")));
const bridgeHosts = hosts.filter((h) => /127\.0\.0\.1|localhost/.test(h));
ok("the local bridge is allowed (http + ws on 127.0.0.1)",
  bridgeHosts.some((h) => h.startsWith("http://127.0.0.1")) &&
  bridgeHosts.some((h) => h.startsWith("ws://127.0.0.1")));
ok("ChatGPT's hosts are allowed",
  hostSet.has("chatgpt.com") && hostSet.has("chat.openai.com"));

// ── Script order per site ──────────────────────────────────────────────────
// The four files a provider entry MUST load, in this exact relative order.
const CORE_ORDER = ["core/config.js", "core/parser.js", "core/main.js"];
const providerOf = (js) => js.filter((f) => /^providers\/[^/]+\.js$/.test(f));
const orderOf = (js, wanted) => wanted.map((f) => js.indexOf(f));

const entries = manifest.content_scripts || [];
const coreEntries = entries.filter((e) => (e.js || []).includes("core/main.js"));
ok("every AI site has an entry that boots the core", coreEntries.length > 0);
ok("no entry boots the core twice for the same host",
  new Set(coreEntries.map((e) => (e.matches || []).join(","))).size === coreEntries.length);

for (const e of coreEntries) {
  const label = (e.matches || []).join(" ");
  const js = e.js || [];
  const [iCfg, iParse, iMain] = orderOf(js, CORE_ORDER);
  const providers = providerOf(js);
  const iProv = providers.length === 1 ? js.indexOf(providers[0]) : -1;
  ok(`${label}: loads config -> parser -> provider -> main`,
    iCfg === 0 && iParse === 1 && providers.length === 1 && iProv === 2 && iMain === 3,
    js.join(" -> "));
  ok(`${label}: runs at document_idle (config/parser/provider must exist first)`,
    e.run_at === "document_idle");
  ok(`${label}: ships the CSS the bar and chips need`,
    (e.css || []).includes("overlay.css"));
  ok(`${label}: declares no dashboard/handoff script`,
    !js.some((f) => /dashboard|handoff|prompt-architect/i.test(f)), js.join(", "));
}

// ── ChatGPT specifically ───────────────────────────────────────────────────
const chatgptEntries = entries.filter((e) => (e.matches || []).includes("https://chatgpt.com/*"));
ok("ChatGPT has a content-script entry for both chatgpt.com and chat.openai.com",
  chatgptEntries.length > 0 &&
  chatgptEntries.some((e) => (e.matches || []).includes("https://chat.openai.com/*")));
const chatgptCore = chatgptEntries.find((e) => (e.js || []).includes("core/main.js"));
ok("ChatGPT boots the standard core (not a bespoke dashboard script)",
  !!chatgptCore && (chatgptCore.js || []).join(",") ===
    "core/config.js,core/parser.js,providers/chatgpt.js,core/main.js",
  chatgptCore && (chatgptCore.js || []).join(","));
const chatgptTap = chatgptEntries.find((e) => (e.js || []).includes("providers/chatgpt-cm.js"));
ok("ChatGPT's MAIN-world editor tap runs at document_start",
  !!chatgptTap && chatgptTap.world === "MAIN" && chatgptTap.run_at === "document_start" &&
  (chatgptTap.js || []).join(",") === "providers/chatgpt-cm.js");

// ── Every referenced file exists ───────────────────────────────────────────
const referenced = new Set();
for (const e of entries) for (const f of [...(e.js || []), ...(e.css || [])]) referenced.add(f);
if (manifest.background) referenced.add(manifest.background.service_worker);
if (manifest.action && manifest.action.default_popup) referenced.add(manifest.action.default_popup);
if (manifest.icons) for (const f of Object.values(manifest.icons)) referenced.add(f);
const missingFiles = [...referenced].filter((f) => !fs.existsSync(path.join(EXT, f)));
ok("every file the manifest references exists", missingFiles.length === 0, missingFiles.join(", "));

// Every provider module in the tree must be registered by exactly one entry (or
// be a MAIN-world helper tap that is registered on its own).
const helperTaps = new Set(["providers/chatgpt-cm.js", "providers/qwen-net.js"]);
const providerFiles = fs.readdirSync(path.join(EXT, "providers")).map((f) => "providers/" + f);
const unregistered = providerFiles.filter((f) => !referenced.has(f) && !helperTaps.has(f));
ok("every provider module is registered in a content script",
  unregistered.length === 0, unregistered.join(", "));

// ── Cross-file host agreement ──────────────────────────────────────────────
// A provider whose host is missing from ONE of these lists fails in a way that is
// very hard to see from the code: the content script never injects (manifest), the
// status never reaches the tab (background), or the popup sends the user nowhere.
const bgUrls = (read("background.js").match(/const PROVIDER_URLS = \[([\s\S]*?)\];/) || [,""])[1];
const bgHosts = new Set([...bgUrls.matchAll(/https:\/\/([^/]+)\/\*/g)].map((m) => m[1]));
const popupHosts = new Set(
  [...(read("popup.js").match(/const SUPPORTED_HOSTS = \[([\s\S]*?)\];/) || [,""])[1].matchAll(/"([^"]+)"/g)]
    .map((m) => m[1]));
const siteHosts = new Set(
  [...read("core/main.js").matchAll(/\{ name: "[^"]+", url: "https:\/\/([^/]+)/g)].map((m) => m[1]));

// Hosts the content scripts are actually injected into (the functional set;
// host_permissions also carries a few apex/alias hosts that only redirect, and
// those are not expected in the switcher).
const injectedHosts = [...new Set(entries.flatMap((e) => e.matches || [])
  .map((m) => m.replace(/^https:\/\//, "").replace(/\/\*$/, "")))];
const notInBackground = injectedHosts.filter((h) => !bgHosts.has(h));
const notInPopup = injectedHosts.filter((h) => !popupHosts.has(h));
ok("every injected host is watched by the background worker",
  notInBackground.length === 0, notInBackground.join(", "));
ok("every injected host is listed in the popup",
  notInPopup.length === 0, notInPopup.join(", "));
ok("every site in the in-page AI switcher is injected, permitted and watched",
  [...siteHosts].every((h) => injectedHosts.includes(h) && hostSet.has(h) && bgHosts.has(h)),
  [...siteHosts].filter((h) => !(injectedHosts.includes(h) && hostSet.has(h) && bgHosts.has(h))).join(", "));
ok("the background worker watches no host the extension is not allowed to touch",
  [...bgHosts].every((h) => hostSet.has(h)),
  [...bgHosts].filter((h) => !hostSet.has(h)).join(", "));

// ── No dashboard coupling ──────────────────────────────────────────────────
ok("no dashboard/handoff/prompt-architect file is shipped or referenced",
  !/\bdashboard\b|dashboard-handoff|prompt-architect/i.test(read("manifest.json")) &&
  !fs.existsSync(path.join(EXT, "core/dashboard-handoff.js")) &&
  !fs.existsSync(path.join(EXT, "core/prompt-architect.js")));
