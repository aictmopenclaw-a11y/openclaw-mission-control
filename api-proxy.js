#!/usr/bin/env node
// OpenClaw Mission Control — API Proxy
// Bridges browser requests to OpenClaw gateway RPC (handles CORS)
// Usage: OPENCLAW_TOKEN=yourtoken node api-proxy.js

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = process.env.PROXY_PORT || 3100;
const GATEWAY = process.env.OPENCLAW_GATEWAY || 'http://127.0.0.1:54924';
const TOKEN = process.env.OPENCLAW_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || '';
const CONFIG_PATH = process.env.OPENCLAW_CONFIG || '/data/.openclaw/openclaw.json';

const fs = require('fs');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function json(res, code, data) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function proxyRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, GATEWAY);
    const mod = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`
      }
    };
    const req = mod.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function checkAuth(req) {
  const auth = req.headers.authorization || '';
  const provided = auth.replace(/^Bearer\s+/i, '');
  return provided === TOKEN;
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);

    // Also load models.json if available
    const modelsPath = CONFIG_PATH.replace('openclaw.json', 'agents/main/agent/models.json');
    let models = [];
    try {
      const mRaw = fs.readFileSync(modelsPath, 'utf8');
      const mData = JSON.parse(mRaw);
      // Flatten providers into a model list
      if (mData.providers) {
        for (const [provider, pConf] of Object.entries(mData.providers)) {
          if (pConf.models) {
            for (const m of pConf.models) {
              models.push({
                id: m.id,
                alias: m.alias || m.id,
                provider,
                context: m.context || null,
                maxTokens: m.maxTokens || null
              });
            }
          }
        }
      }
    } catch {}

    return { ...cfg, models };
  } catch (e) {
    return { error: e.message };
  }
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    return res.end();
  }

  // Auth check
  if (!checkAuth(req)) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    // /config — read local config + models
    if (url.pathname === '/config') {
      return json(res, 200, loadConfig());
    }

    // /rpc — proxy to gateway
    if (url.pathname === '/rpc' && req.method === 'POST') {
      const body = await readBody(req);
      const { method: rpcMethod, args } = JSON.parse(body);

      // Map RPC method to gateway endpoint
      const gwPath = `/api/rpc/${rpcMethod.replace(/\./g, '/')}`;
      const result = await proxyRequest('POST', gwPath, JSON.stringify(args || {}));
      return json(res, 200, result);
    }

    // /health — simple proxy health
    if (url.pathname === '/health') {
      return json(res, 200, { status: 'ok', gateway: GATEWAY, time: new Date().toISOString() });
    }

    json(res, 404, { error: 'Not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mission Control Proxy listening on http://0.0.0.0:${PORT}`);
  console.log(`Gateway: ${GATEWAY}`);
  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Auth: ${TOKEN ? 'token set' : 'NO TOKEN — set OPENCLAW_TOKEN'}`);
});
