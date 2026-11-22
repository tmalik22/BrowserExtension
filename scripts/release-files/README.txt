Browser Agent server
====================

This is the local server for the Browser Agent Chrome extension. It runs the AI model loop on
your computer, so your API keys and the pages you browse stay here.

1. Install Node.js 20 or newer from https://nodejs.org/ (skip if you already have it).
2. Start the server:
     Windows:        double-click "Start Browser Agent.cmd"
     macOS / Linux:  open a terminal in this folder and run  ./start.sh
3. Open the Browser Agent side panel in Chrome and click "Pair this browser".
   The side panel and this server window show the same 6-digit code. If they match, click
   "Codes match" in the panel and type y here. (Or paste the pairing token this server prints
   into the side panel: Settings -> Pairing token.)

Models
  - Running Ollama or LM Studio? Your installed models show up automatically.
  - Cloud models: add your API key in the side panel (Settings -> API keys).
  - Custom setups: copy models.example.json to models.json and edit it.

Keep the server window open while you use the agent. Your settings, keys and chat history are
stored in the "data" folder next to this file.

Docs, help and source: https://github.com/tmalik22/BrowserExtension
