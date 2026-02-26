# OpenClaw Mission Control

A single-file dashboard for monitoring and managing your OpenClaw instance. Zero dependencies, works in any browser.

## What You Get

- **System Health** — Gateway status, uptime, security warnings
- **Agents** — Your agents (Bob/Wizard), model, activity
- **Channels** — Telegram, Email, WhatsApp status
- **Models** — All configured models across providers (OpenAI, Anthropic, Google, NVIDIA, Moonshot)
- **Sessions** — Active conversations with token usage
- **Task Board** — Drag-and-drop Kanban (persisted in localStorage)
- **Quick Actions** — Health checks, channel status, cron jobs

## Quick Start

### 1. Start the API Proxy

The proxy bridges your browser to OpenClaw's gateway (handles CORS):

```bash
# On your OpenClaw server
cd openclaw-mission-control
OPENCLAW_TOKEN=your-gateway-token node api-proxy.js
```

Environment variables:
| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_TOKEN` | (required) | Gateway auth token |
| `OPENCLAW_GATEWAY` | `http://127.0.0.1:54924` | Gateway URL |
| `PROXY_PORT` | `3100` | Proxy listen port |
| `OPENCLAW_CONFIG` | `/data/.openclaw/openclaw.json` | Config file path |

### 2. Open the Dashboard

**Option A — Local file:**
Open `index.html` in your browser.

**Option B — GitHub Pages:**
Visit your repo's GitHub Pages URL.

### 3. Configure Connection

1. Click **Settings** in the top-right
2. Enter your proxy URL (e.g., `http://your-server:3100`)
3. Enter your gateway token
4. Click **Save & Connect**

## Running with Docker

If OpenClaw runs in Docker, start the proxy on the host:

```bash
# The proxy reads config from the mounted volume
OPENCLAW_TOKEN=fcoNurBnuE43l4OEved9nkG84PlnuGWH \
OPENCLAW_CONFIG=/docker/openclaw-jq0y/data/.openclaw/openclaw.json \
node api-proxy.js
```

## Architecture

```
Browser ──→ api-proxy.js (:3100) ──→ OpenClaw Gateway (:54924)
  │              │
  │              └─ Reads openclaw.json + models.json directly
  └─ index.html (static, no build step)
```

## Files

- `index.html` — Complete dashboard (HTML + CSS + JS, no dependencies)
- `api-proxy.js` — Node.js CORS proxy (~100 lines, no npm packages)
- `README.md` — This file
