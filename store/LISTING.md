# Chrome Web Store submission pack

Everything to paste into the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole). Upload **`release/browser-agent-chrome-store-v<version>.zip`** (made by `npm run release`). That's the store build, without `javascript_exec`.

---

## 1. Before you start (one time)

1. Sign in to the Developer Dashboard with the Google account you want to publish under.
2. Pay the **one-time $5 registration fee** and accept the developer agreement.
3. Verify your contact email (Account → contact email).
4. Set **Account → Publisher display name** to **Trapped Ion Systems**, and the publisher website to `https://trappedionsystems.com`. The store shows this under the extension name.

## 2. Upload

**Items → New item → upload the zip.** The dashboard assigns the extension ID immediately. Note it down.

## 3. Store listing tab

**Name:** `Browser Agent`

**Summary** (max 132 characters):
```
Open-source AI agent that works in your browser, with any model: local (Ollama, LM Studio) or your own API keys.
```

**Category:** Productivity  **Language:** English

**Description:**
```
Browser Agent is an open-source AI agent that works in Chrome for you: it reads pages, clicks, types, fills in forms and handles tabs, while you watch every step in the side panel.

Bring any model
• Local models on your own computer: Ollama, LM Studio, vLLM, llama.cpp (detected automatically).
• Or your own API keys: NVIDIA NIM, NanoGPT, OpenRouter, Anthropic, OpenAI, Google Gemini, Groq, xAI, DeepSeek, Mistral, or any OpenAI-compatible service.
• Always-current model lists: add a key and that provider's full model list appears, refreshed automatically. Search hundreds of models in the model picker.
• Works with small models too: a compact toolset and modes for models without vision or tool calling.

You stay in control
• It stops and asks before purchases and payments, logging in, typing passwords or card numbers, sending messages, deleting things, changing account settings, accepting terms and more. Eleven separate switches let you choose.
• It only works in the tabs of the task you start (its own tab group), never your other tabs.
• Stop it instantly from the side panel or the on-page Stop button.

Private by design
• Browser Agent needs a small companion server that runs on your own computer (free download, see the website). The extension only talks to that server.
• Your API keys stay on your computer. No account, no analytics, no telemetry. The developers never receive your data.

Also included
• Optional CAPTCHA helper: a free local CAPTCHA model (CaptchaKraken v1.2, run with Ollama, LM Studio or llama.cpp; about 7 GB of GPU memory) clears Cloudflare / reCAPTCHA / hCaptcha checks so the task can continue.
• Searchable chat history, a GPU monitor for local models, and a CLI and HTTP API for developers.

Setup takes about two minutes: download and start the server, open the side panel, click Pair, and check that both windows show the same code.

Made by Trapped Ion Systems: https://trappedionsystems.com
Like it? Tips welcome: https://ko-fi.com/timmalik
Open source (MIT): https://github.com/tmalik22/BrowserExtension
```

**Graphics** (all in this folder):

| Field | File |
|---|---|
| Store icon (128×128) | `icon-128.png` |
| Screenshots (1280×800, up to 5) | `screenshot-1.png` … `screenshot-5.png` |
| Small promo tile (440×280) | `promo-small.png` |
| Marquee promo tile (1400×560, optional) | `promo-marquee.png` |

The store won't accept GitHub links for these, so they point at the project website in `site/`, deployed with Cloudflare Pages on a free subdomain of trappedionsystems.com:

**Official URL / homepage:** `https://browseragent.trappedionsystems.com/`
**Support URL:** `https://browseragent.trappedionsystems.com/support`

To set the subdomain up (trappedionsystems.com's DNS is already on Cloudflare, so this costs nothing):

1. Cloudflare dashboard → **Workers & Pages** → the Browser Agent Pages project → **Custom domains** → **Set up a custom domain**.
2. Enter `browseragent.trappedionsystems.com` and confirm. Cloudflare adds the DNS record and the certificate itself.

The **Official URL** must be verified in [Google Search Console](https://search.google.com/search-console). Add a **Domain** property for `trappedionsystems.com` and verify it with the DNS TXT record (Cloudflare can add it in one click). That covers every subdomain, including this one.

## 4. Privacy practices tab

**Single purpose description:**
```
Browser Agent lets the user delegate browsing tasks to an AI model of their choice. The extension reads and operates the web pages of the task the user starts (clicking, typing, navigating), and shows each step and approval request in its side panel.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| `debugger` | Carries out the user's task in the page with trusted mouse and keyboard input, page screenshots and dialog handling through the Chrome DevTools Protocol. Attached only to the tabs of the task the user started, and detached when it ends. Chrome shows its debugging banner meanwhile. |
| `tabs` | Opens, switches between and tracks the tabs that belong to the user's task, and reads their URL and title so the agent knows where it is. |
| `tabGroups` | Puts each task's tabs into their own labelled tab group, so the user can see which tabs the agent is using and the agent never touches other tabs. |
| `scripting` | Injects the extension's own bundled content script into frames of task tabs that loaded before the extension started, to read the page structure and fill in forms. No remote code. |
| `storage` | Saves the user's connection settings (local server address and pairing secret) and side-panel preferences. |
| `sidePanel` | The user interface: the user types tasks, watches each step and approves sensitive actions in the side panel. |
| `webNavigation` | Detects page loads and frame navigations in task tabs, so actions wait for the page to be ready and the URL safety policy can be applied to every frame. |
| `downloads` | Reports files that the user's task downloads, so the agent and user can see what was saved. |
| `alarms` | Keeps the connection to the user's local server alive and reconnects after the service worker sleeps. |
| `notifications` | Optional desktop alerts when a local model's GPU overheats (user-enabled in the side panel). |
| Host permissions `<all_urls>` | The agent works on whatever website the user asks it to work on, so it must be able to read and operate any page the user chooses. It only does so in the tabs of a task the user started, and it can't run on pages the user blocks in settings. |

**Remote code:** *No, I am not using remote code.* All JavaScript is in the package. Model responses are treated as data (tool names and arguments checked against a fixed list), never executed. The store build removes the optional `javascript_exec` tool.

**Data usage.** Tick **Website content** and **User activity** (the agent's clicks and keystrokes in task tabs). Then certify:
- ☑ I do not sell or transfer user data to third parties, apart from the approved use cases.
- ☑ I do not use or transfer user data for purposes unrelated to my item's single purpose.
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes.

(The data goes only to the user's own local server, and from there to the model provider *the user* configures.)

**Privacy policy URL:** `https://browseragent.trappedionsystems.com/privacy`

## 5. Distribution

Public · All regions · Free.

## 6. Submit for review

Expect an **in-depth review**, typically several days to a couple of weeks, because of the `debugger` permission and access to all sites. If the reviewer asks questions, answer from the justifications above. Point them at the README's security section and the open-source code.

## 7. After it's approved

1. Copy the extension ID and the store URL.
2. Add the store link to the README's Quick start step 2 (replace "coming soon").
3. Optionally pin the unpacked dev build to the same ID: in the dashboard, Package → View public key, then add it to `packages/extension/static/manifest.json` as `"key"`.
