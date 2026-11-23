# Privacy policy

_Last updated: 22 November 2026_

Browser Agent is an open-source browser extension plus a small server that **you run on your own computer**. It is published by [Trapped Ion Systems](https://trappedionsystems.com). This policy explains what data it handles and where that data goes.

## The short version

- **We (the developers) never receive your data.** There is no Browser Agent cloud service, no account, no analytics, no telemetry and no tracking.
- The extension only talks to **the Browser Agent server you run**, at `127.0.0.1` (your own computer) by default.
- Your server sends page content and your instructions **only to the AI model provider you choose**: a local model on your machine (e.g. Ollama or LM Studio), or a cloud API you add your own key for.

## What the extension handles, and why

| Data | Why | Where it goes |
|---|---|---|
| **Website content** of tabs the agent works in (page text, an outline of the page, screenshots, URLs and titles) | So the AI model you chose can see the page and carry out your task | Your local Browser Agent server, then the model provider you configured |
| **Your instructions** typed into the side panel | To tell the agent what to do | Same as above |
| **Text the agent types** for you (e.g. form fields) | To fill in forms you asked it to | The model you chose writes this text. It is typed into the page and saved in the chat transcript on your own computer. Text typed into password and card fields is masked there |
| **API keys** for model providers, and the **pairing secret** | To use the model provider you chose, and to connect the extension to your server | A key you type into the side panel is passed to your local server, which saves it and sends it to that provider with each request. The extension does not keep the key and never gets the full key back, only its last 4 characters as a hint. The pairing secret is kept in Chrome's local extension storage and on your server |
| **Settings** (permission choices, allowed and blocked sites, server address, pairing secret) | To remember your preferences and connect to your server | Chrome's local extension storage and your server's `data/` folder |

The agent only works in the tabs of the task you started (its own tab group). **It does not read your other tabs** or your browsing history. One thing outside those tabs is reported to the model: downloads that start while a task is running (their address, and whether they finished), including a download you start yourself during that time.

## Model providers

If you use a **cloud** model (for example Anthropic, OpenAI, Google, OpenRouter or Groq), your server sends the page content and instructions for each task to that provider, using **your own API key**. Their privacy policies apply to that data. With a **local** model (Ollama, LM Studio, vLLM, llama.cpp), nothing leaves your computer.

## Storage on your computer

Your server keeps, in its `data/` folder on your machine:
- your API keys (`keys.json`, in plain text; the file is marked private to your user account),
- settings, the pairing token and paired-browser secrets,
- task transcripts and screenshots for the chat history (in `data/sessions`), kept until you delete them.

You can delete this folder at any time. Set `AGENT_KEEP_DAYS` to a number of days to have older transcripts deleted when the server starts, or set `AGENT_TRANSCRIPTS=0` to stop saving transcripts.

## Selling and sharing

We do not sell, rent or share any data. We have no way to: your data never reaches us.

## Children

Browser Agent is not directed at children under 13.

## Changes and contact

Changes to this policy are published in this file in the [GitHub repository](https://github.com/tmalik22/BrowserExtension). Questions: open an issue or [discussion](https://github.com/tmalik22/BrowserExtension/discussions) on GitHub.
