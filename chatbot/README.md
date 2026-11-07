# Standalone AI Chatbot

A fast, lightweight, standalone chatbot interface designed for custom AI proxies (including Conpi TEE proxy API keys, OpenRouter, and OpenAI-compatible endpoints).

## Features
- **Completely Independent**: Zero links to or dependencies on Conpi. Runs on its own.
- **Custom Proxy API Key**: Easily configure your proxy API key (`cpk_live_...` or any bearer key).
- **Custom Model & Base URL**: Supports DeepSeek, Claude, Llama, and OpenAI models with configurable endpoint.
- **Real-Time Streaming**: Live streaming token generation using Server-Sent Events (SSE).
- **Full Markdown & Code Highlighting**: Syntax highlighting with automatic "Copy Code" button.
- **Chat History Management**: Multiple chat sessions, rename, delete, and export to Markdown.
- **Local Privacy**: Your API key and chats are stored strictly inside your own browser's `localStorage`.

## Quick Start

### Option 1: Run with Node.js
```bash
cd chatbot
node server.js
```
Then open [http://localhost:4000](http://localhost:4000) in your browser.

### Option 2: Open Directly
Double-click or open `chatbot/index.html` directly in any modern browser (Chrome, Brave, Safari, Edge, Firefox).
