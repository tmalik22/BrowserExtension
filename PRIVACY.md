# Privacy policy

_Last updated: 22 November 2026_

Browser Agent is an open-source browser extension plus a small server that **you run on your own computer**. This policy explains what data it handles and where that data goes.

## The short version

- **We (the developers) never receive your data.** There is no Browser Agent cloud service, no account, no analytics, no telemetry and no tracking.
- The extension only talks to **the Browser Agent server you run**, at `127.0.0.1` (your own computer) by default.
- Your server sends page content and your instructions **only to the AI model provider you choose**: a local model on your machine (e.g. Ollama or LM Studio), or a cloud API you add your own key for.

## What the extension handles, and why

| Data | Why | Where it goes |
|---|---|---|
| **Website content** of tabs the agent works in (page text, an outline of the page, screenshots, URLs and titles) | So the AI model you chose can see the page and carry out your task | Your local Browser Agent server, then the model provider you configured |
| **Your instructions** typed into the side panel | To tell the agent what to do | Same as above |
| **Text the agent types** for you (e.g. form fields) | To fill in forms you asked it to | Stays in the page. Password and card fields are masked in logs |
| **Settings** (permission choices, allowed and blocked sites, server address, pairing secret) | To remember your preferences and connect to your server | Chrome's local extension storage and your server's `data/` folder |

The agent only works in the tabs of the task you started (its own tab group). **It does not read your other tabs** or your browsing history.

## Model providers

If you use a **cloud** model (for example Anthropic, OpenAI, Google, OpenRouter or Groq), your server sends the page content and instructions for each task to that provider, using **your own API key**. Their privacy policies apply to that data. With a **local** model (Ollama, LM Studio, vLLM, llama.cpp), nothing leaves your computer.

## Storage on your computer

Your server keeps, in its `data/` folder on your machine:
- your API keys (`keys.json`, readable only by your user account),
- settings, the pairing token and paired-browser secrets,
- task transcripts and screenshots for the chat history.

You can delete this folder at any time. Set `AGENT_TRANSCRIPTS=0` to stop saving transcripts.

## Selling and sharing

We do not sell, rent or share any data. We have no way to: your data never reaches us.

## Children

Browser Agent is not directed at children under 13.

## Changes and contact

Changes to this policy are published in this file in the [GitHub repository](https://github.com/tmalik22/BrowserExtension). Questions: open an issue or [discussion](https://github.com/tmalik22/BrowserExtension/discussions) on GitHub.
