# Architecture and design notes

## Why it is built this way

A good browser agent needs (1) a model that knows the tool contract it is given and (2) a
harness that gives the model a compact, actionable view of the page and reliable actions. This
project implements the public `browser_toolset_20260801` **contract** and builds its own
harness from scratch.

## Components

### Agent server (`packages/server`)

- **Session loop** (`agent/session.ts`). Each user message runs:
  model → member calls → policy (+ approval) → `execute` RPC to the extension → append results →
  model … until the model answers in text, the user stops it, or `maxSteps` is hit.
  - Calls in one assistant turn are a *batch*: run in order, stop at the first failure, answer
    every later call with `Not executed: an earlier action in this turn failed.`
  - Every `tool_use` gets exactly one `tool_result`, even when stopped mid-batch or refused, so
    the conversation is always valid for the next request.
  - **History is append-only.** Provider adapters convert it deterministically, so each request's
    prefix is byte-identical to the previous one. This keeps prompt caching effective and is
    required by Anthropic's *preserved thinking* (editing earlier turns invalidates thinking
    blocks on recent Anthropic models). Anthropic assistant turns are replayed verbatim (signatures included).
  - The member set is fixed at session start (changing tools mid-session breaks both).
  - Stop takes effect immediately, including during a long-running action.
- **CAPTCHA helper** (`session.ts`): when a navigation (or a finished turn) leaves a Cloudflare/Turnstile-style challenge on screen, a configured helper profile gets a fresh screenshot and a 6-action budget to solve only the challenge. It runs in an isolated conversation; the main model receives a short note, re-reads the page and continues. Detection is a DOM/URL probe in the extension, not model guesswork.
- **Policy** (`agent/policy.ts`) runs before every call, independent of the model. The extension
  first `describe`s what the call would touch (element role/name, form context, sensitivity,
  page URL); the policy then allows, denies, or asks the user. What it asks about is split into
  confirmation categories (`ConfirmCategory` in `shared/protocol.ts`: payments, logins, sensitive
  fields, messages, deletions, account changes, agreements, forms, dialogs, scripts/uploads,
  unknown targets), each switchable in settings; a control label matching several categories asks
  while any of them is on. Hard denies (URL policy, disabled tools, upload paths) are not switchable.
- **Providers** (`providers/`):
  - `anthropic.ts` — native toolset entry with `configs` to enable/disable members; adaptive
    thinking (summarized, streamed to the UI); `output_config.effort`; automatic prompt caching;
    server-side tool-result clearing (`clear_tool_uses_20250919`) instead of client pruning;
    server-side refusal fallbacks (`fallbacks: "default"`, retried without it if rejected);
    `browser_state` blocks passed through so the API renders tab context.
  - `openai.ts` — Chat Completions with function tools (flat JSON schemas, no `oneOf`, for
    compatibility); tool results as `tool` messages, screenshots as a following `user` message;
    `browser_state` rendered to text exactly like the Anthropic API renders it (tab-management
    texts, deduped *Tab Context* footer, download lines); batched pruning of old screenshots so
    the prefix only changes every 8 images; `<think>`/`reasoning_content` handling; JSON tool
    mode for models without function calling.
  - `mock.ts` — scripted model for tests and demos.
- **Server** (`server.ts`) — WebSocket hub (token pairing, origin check, heartbeat, reconnect
  grace period so a service-worker restart doesn't fail an action), event fan-out with replay
  buffers (side panel can be closed and reopened), approvals, HTTP API with SSE.

### Extension (`packages/extension`)

- **Service worker** (`background/`)
  - `cdp.ts` — `chrome.debugger` attach per tab, `Page`/`Network` domains, focus emulation (acts
    in background tabs without stealing focus), network-idle tracking, JS dialog tracking,
    console/network buffers (Runtime is only enabled when `read_console` is used, since pages can
    detect it). After attaching it waits for the viewport to settle: Chrome's "debugging this
    browser" bar resizes the page a moment later.
  - `executor.ts` — the 31 members. Ref targets are resolved by the frame's content script
    (scroll into view, hit-test, label proxy for visually hidden checkboxes), offset into
    top-level viewport coordinates, then clicked with CDP mouse events. Coordinate targets are
    scaled from screenshot pixels to CSS pixels. Covered elements are reported, never clicked
    through (the cover might be a confirmation dialog). After acting it waits for the page to
    settle (no main-frame load, network idle ignoring long-polls, DOM briefly quiet — capped,
    because many pages mutate constantly).
  - `input.ts` — key chords/sequences (xdotool-style aliases), editing commands that CDP needs
    explicitly (`selectAll`, `copy`, `undo` …), realistic per-character typing for short text,
    `insertText` for long text. Input dispatch returns as soon as a JS dialog opens (CDP input
    otherwise blocks until the dialog closes).
  - `frames.ts` — messaging content scripts per frame (injecting on demand), the **frame probe**
    (child frame posts a random token to its parent; the parent's content script finds the
    `<iframe>` whose `contentWindow` sent it and reports its content-box offset — works across
    origins), and the per-tab **ref registry**: `ref_N` ↔ (frameId, document nonce, element id),
    stable until the tab navigates, persisted in `storage.session` across service-worker restarts.
  - `screenshot.ts` — capture, resize to ≤1568 px long edge / ≤1.15 MP (fits every model's image
    limits, including the stricter limit once a request holds >20 images), remember the scale.
  - `sessions.ts` — tab group per task, page-opened tabs join with `tab_opened`, active-tab
    tracking, `browser_state` blocks, downloads (`download_started/completed/failed`).
- **Content script** (`content/`, every frame, isolated world)
  - `outline.ts` — the `read_page` tree: ARIA roles (explicit and implicit), accessible names
    (`aria-labelledby`, `aria-label`, labels, alt, title, placeholder, text), states and values
    (masked for sensitive fields), open shadow roots and slots, viewport / interactive / all
    filters, depth, subtree reads, `<iframe>` lines where the service worker nests child frames.
  - `actions.ts` — `find` (lexical scoring with role synonyms and fuzzy matching), page text
    (main content first), resolve/hit-test, `form_input` (native value setters + events so React
    and other controlled inputs update), describe for the policy, DOM-quiet detection.
  - `overlay.ts` — glow frame, status pill with Stop, animated cursor, optional input lock;
    hidden during screenshots and excluded from page reads.
- **Side panel** (`sidepanel/`) — vanilla TypeScript; renders model output with DOM nodes only
  (never HTML), so page-derived text can't inject markup.

## Trade-offs and limits

- `chrome.debugger` shows a browser-wide infobar; there's no way around it for an extension
  (Comet avoids it by being a browser fork).
- `find` is lexical; it does well on labelled UIs but can miss icon-only buttons. `read_page`
  and screenshots cover those.
- `file_upload` supports paths in the server's upload folder (same machine), not `document_ids`.
- Cross-origin iframes are read and clicked fine; `file_upload` into a cross-origin frame is not
  supported.
- Download attribution uses "the session that is running" (Chrome download events carry no tab).
- The Anthropic computer-use toolset (desktop control) isn't wired in; the browser toolset is the
  right tool for in-browser tasks.

## Extending

- New provider: implement `Provider.complete()` (see `providers/types.ts`); convert the neutral
  `Turn[]` deterministically.
- New member behaviour: `executor.ts` (service worker) + content-script handler in
  `content/index.ts`; add an e2e test with a fixture page in `e2e/fixtures/site`.
- Deploying the server remotely: put it behind TLS (wss://), set `AGENT_TOKEN` and
  `AGENT_EXTENSION_IDS`, and keep `file_upload` off (paths refer to the server's disk).
