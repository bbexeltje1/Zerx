# ZeroScript Free - AI Roblox Studio Agent (ChatGPT, DeepSeek, Gemini, Kimi, GLM, Qwen, Arena, Meta AI)

Control Roblox Studio with AI, for free. ZeroScript turns a normal AI chat (ChatGPT, DeepSeek, Google Gemini, Kimi, GLM, Qwen, Arena, or Meta AI) into an agent that builds and scripts your Roblox game for you: just describe what you want, and it reads/edits scripts, runs Luau, inspects the game tree, and generates assets directly in Roblox Studio. No API key, no terminal, no coding required.

It's a Chrome/Edge browser extension plus a small local bridge that connects the chat to Roblox Studio through the official MCP server. **DeepSeek is the recommended provider.** ChatGPT, Gemini, Kimi, GLM, Qwen, Arena and Meta AI also work. On ChatGPT, screenshots and image input are disabled on purpose (its free tier caps files/images on a separate quota from messages, so vision would only work part of the day); ChatGPT also summarises its own context in long sessions, so ZeroScript re-states its operating instructions periodically (shown as a "Reminder" chip) to stop it forgetting it can run commands. Gemini and Kimi can be less stable: Gemini tends to stop using the Roblox tools in long sessions, and Kimi sometimes reaches for its own native tools instead of the Roblox commands. On Arena, keep the mode dropdown on **Direct** (ZeroScript only supports Direct mode).

## Setup

**Load the extension manually (Edge or Chrome):**
1. Go to `edge://extensions` (Edge) or `chrome://extensions` (Chrome)
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `zeroscript-extension` folder
5. The extension is now active

**Then set up the Bridge:**
1. **Download the Bridge** from the [GitHub releases page](https://github.com/sebattfg/ZeroScript-Free)
2. **Open Roblox Studio** and load a Place
3. **Enable the MCP server in Roblox Studio** (first time only): click **Assistant AI** in the top bar, then **...** > **Manage MCP Servers** > **Enable Studio as MCP Server**
4. **Run the Bridge** - double-click `start.bat` (Windows) or `MacOS_Start.command` (macOS); a small window opens, the Bridge is running. On macOS, the first launch shows a Gatekeeper warning (normal for any downloaded script): click **Done**, then **System Settings > Privacy & Security**, scroll down, and click **Open Anyway**.
5. **Go to https://chat.deepseek.com** (recommended), https://chatgpt.com, https://gemini.google.com, https://www.kimi.com, https://chat.z.ai, https://chat.qwen.ai, https://arena.ai, or https://www.meta.ai, open a new chat (only works on these exact addresses; on Arena use Direct mode)
6. Click **Start session** in the ZeroScript panel
7. Type what you want to build

📺 [Watch the setup tutorial](https://youtu.be/kPKiZLZ9_Ps)

## Architecture (for contributors)

The extension is split between a provider-agnostic core and per-AI-site providers:

```
core/config.js        system prompt, feedback strings, tool categories (global ZS)
core/parser.js        ZeroScript command parsing - pure string logic   (global ZSParse)
core/main.js          agentic loop, UI, camouflage, session state      (uses ZSProvider)
providers/deepseek.js everything DeepSeek-specific: DOM selectors, generation
                      detection, send mechanics, composer modes…       (global ZSProvider)
providers/gemini.js   same interface for Google Gemini (Angular DOM, Quill
                      composer, code-block masking)                    (global ZSProvider)
providers/kimi.js     same interface for Kimi / Moonshot AI (Vue DOM, Lexical
                      composer, segment-code masking)                  (global ZSProvider)
providers/glm.js      same interface for GLM / Z.ai (Svelte DOM, code-block
                      wrapper masking)                                 (global ZSProvider)
providers/qwen.js     same interface for Qwen / chat.qwen.ai (Vue DOM, network-tap
                      SSE stream, Monaco disposal guard)               (global ZSProvider)
providers/qwen-net.js MAIN-world fetch tap for Qwen SSE stream        (injected by manifest)
providers/chatgpt.js  same interface for ChatGPT / chatgpt.com (React DOM,
                      ProseMirror composer, CodeMirror reply reading) (global ZSProvider)
providers/chatgpt-cm.js MAIN-world CodeMirror tap: republishes each code block's
                      TRUE document (the rendered DOM truncates long
                      lines)                                          (injected by manifest)
providers/arena.js    same interface for Arena / arena.ai (React DOM, multi-model
                      playground, A/B-comparison auto-commit, Direct-mode gate) (global ZSProvider)
providers/meta.js     same interface for Meta AI / meta.ai (React DOM, textarea
                      composer, JSON-viewer + code-collapse masking)   (global ZSProvider)
background.js         WebSocket to the local bridge (provider-agnostic)
```

`core/main.js` never touches the host site's DOM directly - it only calls the
`ZSProvider` interface. To integrate another AI site: write a new
`providers/<site>.js` exporting the same interface, then add its URL pattern to
`manifest.json` (`content_scripts` + `host_permissions`) and to
`PROVIDER_URLS` in `background.js`. No core change required.

Smoke tests (plain Node, no dependencies - run them from this directory):

- `node test-parser.js` - the command parser (`core/parser.js`).
- `node test-chatgpt.js` - ChatGPT reply reading (`providers/chatgpt.js`),
  driven against a stub DOM: CodeMirror line joining, the `data-zs-cm`
  MAIN-world tap that long code blocks depend on, and subtree exclusion.
- `node test-agent-startup.js` - the standalone agent startup path: every
  provider implements the full `ZSProvider` contract the core declares
  (`REQUIRED_PROVIDER_API`), the bar renders a Start control that routes to the
  ordinary bootstrap (`startSession()` -> `list_tools` -> system prompt ->
  `provider.typeAndSend()`), and nothing in the standalone path asks for a
  dashboard, pairing, handoff or "prompt architect" mode. It also drives the
  ChatGPT adapter end to end against a fake composer (the bootstrap prompt is
  typed in and the send control is clicked exactly once).
- `node test-chatgpt-composer.js` - ChatGPT composer detection
  (`providers/chatgpt.js`): the legacy `#prompt-textarea`, the current ProseMirror
  textbox inside the composer form (ChatGPT's 2026-09 "Chat / Work" redesign
  removed that id), a composer that mounts after page init, and the things that
  must never be mistaken for it (stray contenteditables, transcript "edit
  message" editors, hidden/aria-hidden editors). Also pins `barMount()`'s refusal
  to insert the bar into a composer grid that has no safe full-width row.
- `node test-chatgpt-turns.js` - ChatGPT message detection
  (`providers/chatgpt.js`): both DOM generations (legacy
  `[data-message-author-role]` elements and the current `[data-turn-key]`
  containers with `[data-user-message-bubble]` /
  `h4[data-conversation-role="assistant"]` markers), one-turn enumeration with no
  nested duplicates, stable identity across DOM replacement, chrome-free text
  (no "You said:" / "ChatGPT said:" / Copy leaking into the parser), multiline
  code through the MAIN-world tap, the current send/stop controls, and the
  `turns.model` / `turns.unrecognized` diagnostics.
- `node test-manifest.js` - `manifest.json`: MV3 shape, host permissions, script
  order per site (`config -> parser -> provider -> main`), every referenced file
  exists, and the manifest / background / popup / in-page switcher host lists
  agree.

All of them print `PASS`/`FAIL` per case and exit non-zero on failure. They are
mocked tests: a stub DOM and a stubbed bridge, never a live ChatGPT tab or
Roblox Studio.

For a whole-chain check without a signed-in browser there is an optional jsdom
probe, which needs jsdom installed outside the repo. It boots the real content
scripts and checks, scenario by scenario, that the bar is actually on screen with
a non-zero rect and an enabled Start control (legacy composer, the current
ProseMirror composer, a composer that mounts late, and a blocking overlay), then
clicks Start and follows the bootstrap:

```
mkdir -p /tmp/zs-probe && cd /tmp/zs-probe && npm init -y && npm i jsdom
NODE_PATH=/tmp/zs-probe/node_modules \
  node <repo>/zeroscript-extension/tools/probe-chatgpt-start.js
```

It reports the bar's display/rect per scenario, the diag events the click
produced and the messages sent to the bridge. Its page is synthetic, its layout
is emulated and its bridge is a stub, so it is still not a live verification.

A second probe runs the WHOLE agent loop end to end against the current message
markup (`[data-turn-key]` containers, no `[data-message-author-role]`):

```
NODE_PATH=/tmp/zs-probe/node_modules \
  node <repo>/zeroscript-extension/tools/probe-chatgpt-loop.js
```

Its page half is a small event-driven model of ChatGPT - it echoes every message
the extension sends and answers each user turn from a script, streaming the reply
with a stop control present while it types - so the extension keeps its own
pacing instead of racing a hand-stepped simulation. It then asserts, in order:
the `⟦ZS-SYS⟧` bootstrap turn exists and is concealed behind the ZeroScript chip
with nothing raw left visible; the bootstrap reply is read and the bar reaches
"Agent active"; a typed project request is sent through the normal composer; the
`{"command":"list_commands"}` reply is recognised as ONE assistant turn, its
JSON masked, and the command dispatched exactly once; the `Output of
'list_commands'` result is injected, concealed behind a result chip and
recognised as extension feedback; the final answer ends the loop as `text`
without a parse error; and no turn is reported as unrecognisable. All mocked -
the "model" is scripted and the bridge is a stub - so it is not live
verification either, but it is the closest thing to it that runs without a
signed-in browser.

## Support

☕ [Ko-fi](https://ko-fi.com/sebattfg) - Robux tip passes available in the extension panel
