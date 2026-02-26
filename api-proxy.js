#!/usr/bin/env node
// OpenClaw Mission Control — API Proxy
// Bridges browser HTTP requests to OpenClaw gateway WebSocket RPC
// Usage: OPENCLAW_TOKEN=yourtoken node api-proxy.js

const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PROXY_PORT || 3100;
const GATEWAY = process.env.OPENCLAW_GATEWAY || 'http://127.0.0.1:54924';
const TOKEN = process.env.OPENCLAW_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || '';
const CONFIG_PATH = process.env.OPENCLAW_CONFIG || '/data/.openclaw/openclaw.json';

// ==================== WebSocket Gateway Client ====================

let WebSocket;
try { WebSocket = require('ws'); } catch {
  console.error('ws module required. Run: npm install ws');
  process.exit(1);
}

let gwSocket = null;
let gwReady = false;
let gwPending = new Map(); // id -> { resolve, reject, timer }
let gwReqId = 0;
let gwEvents = []; // recent events buffer (last 50)
let gwReconnectTimer = null;
let gwStartTime = Date.now();
let gwSnapshot = null; // hello-ok snapshot (health, sessions, presence)

function gwConnect() {
  if (gwSocket && (gwSocket.readyState === WebSocket.OPEN || gwSocket.readyState === WebSocket.CONNECTING)) return;

  const wsUrl = GATEWAY.replace(/^http/, 'ws') + '/ws';
  console.log(`[gw] Connecting to ${wsUrl}...`);
  gwSocket = new WebSocket(wsUrl);
  gwReady = false;

  gwSocket.on('open', () => console.log('[gw] WebSocket open, waiting for challenge...'));

  gwSocket.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // Handle challenge → send connect
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      const nonce = msg.payload?.nonce;
      if (!nonce) return gwSocket.close(1008, 'no nonce');
      gwSendConnect(nonce);
      return;
    }

    // Handle events
    if (msg.type === 'event') {
      // Store latest health data from periodic health events
      if (msg.event === 'health' && msg.payload) {
        gwSnapshot = { ...gwSnapshot, health: msg.payload };
      }
      gwEvents.push({ time: Date.now(), ...msg });
      if (gwEvents.length > 50) gwEvents.shift();
      return;
    }

    // Handle RPC responses (type: "res")
    if (msg.type === 'res' && msg.id) {
      const pending = gwPending.get(msg.id);
      if (pending) {
        gwPending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok !== false) pending.resolve(msg.payload || msg.result || msg);
        else pending.reject(new Error(msg.error?.message || 'RPC error'));
      }
      return;
    }
  });

  gwSocket.on('close', (code, reason) => {
    console.log(`[gw] Disconnected: ${code} ${reason}`);
    gwReady = false;
    gwSocket = null;
    // Reject all pending
    for (const [id, p] of gwPending) {
      clearTimeout(p.timer);
      p.reject(new Error('connection lost'));
    }
    gwPending.clear();
    // Reconnect after delay
    if (!gwReconnectTimer) {
      gwReconnectTimer = setTimeout(() => { gwReconnectTimer = null; gwConnect(); }, 3000);
    }
  });

  gwSocket.on('error', (err) => {
    console.log(`[gw] Error: ${err.message}`);
  });
}

function gwSendConnect(nonce) {
  const id = crypto.randomUUID();
  const params = {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: 'gateway-client',
      displayName: 'Mission Control',
      version: '1.0.0',
      platform: process.platform,
      mode: 'backend',
      instanceId: crypto.randomUUID()
    },
    caps: [],
    auth: { token: TOKEN },
    role: 'operator',
    scopes: ['operator.admin', 'operator.approvals', 'operator.pairing'],
    userAgent: 'MissionControl/1.0'
  };

  const frame = { type: 'req', id, method: 'connect', params };
  gwSocket.send(JSON.stringify(frame));
  console.log('[gw] Sent connect auth (protocol v3)');

  gwPending.set(id, {
    resolve: (payload) => {
      gwReady = true;
      gwSnapshot = payload?.snapshot || payload;
      console.log('[gw] Auth accepted, scopes:', payload?.auth?.scopes);
    },
    reject: (err) => console.log('[gw] Auth rejected:', err.message),
    timer: setTimeout(() => {
      gwPending.delete(id);
      console.log('[gw] Connect timed out');
    }, 10000)
  });
}

function gwCall(method, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!gwSocket || !gwReady) {
      return reject(new Error('not connected to gateway'));
    }
    const id = `rpc-${++gwReqId}`;
    const frame = { type: 'req', method, id, params: args || {} };

    const timer = setTimeout(() => {
      gwPending.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, timeoutMs);

    gwPending.set(id, { resolve, reject, timer });
    gwSocket.send(JSON.stringify(frame));
  });
}

// ==================== HTTP Helpers ====================

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

function checkAuth(req) {
  const auth = req.headers.authorization || '';
  const provided = auth.replace(/^Bearer\s+/i, '');
  return provided === TOKEN;
}

// ==================== Config Reader ====================

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);

    let models = [];

    // Built-in models from env vars
    if (process.env.OPENAI_API_KEY) {
      models.push(
        { id: 'gpt-5.2', alias: 'ChatGPT 5.2', provider: 'openai' },
        { id: 'gpt-5.1-codex', alias: 'ChatGPT 5.1 Codex', provider: 'openai' },
        { id: 'gpt-5', alias: 'ChatGPT 5', provider: 'openai' },
        { id: 'gpt-5-mini', alias: 'ChatGPT 5 Mini', provider: 'openai' },
        { id: 'gpt-4.1', alias: 'ChatGPT 4.1', provider: 'openai' }
      );
    }
    if (process.env.ANTHROPIC_API_KEY) {
      models.push(
        { id: 'claude-opus-4-6', alias: 'Claude Opus 4.6', provider: 'anthropic' },
        { id: 'claude-sonnet-4-5', alias: 'Claude Sonnet 4.5', provider: 'anthropic' },
        { id: 'claude-haiku-4-5', alias: 'Claude Haiku 4.5', provider: 'anthropic' }
      );
    }
    if (process.env.GEMINI_API_KEY) {
      models.push(
        { id: 'gemini-3-pro-preview', alias: 'Gemini 3 Pro Preview', provider: 'google' },
        { id: 'gemini-3-flash-preview', alias: 'Gemini 3 Flash Preview', provider: 'google' },
        { id: 'gemini-2.5-flash', alias: 'Gemini 2.5 Flash', provider: 'google' },
        { id: 'gemini-2.5-flash-lite', alias: 'Gemini 2.5 Flash Lite', provider: 'google' }
      );
    }

    // Custom providers from models.json
    const modelsPath = CONFIG_PATH.replace('openclaw.json', 'agents/main/agent/models.json');
    try {
      const mRaw = fs.readFileSync(modelsPath, 'utf8');
      const mData = JSON.parse(mRaw);
      if (mData.providers) {
        for (const [provider, pConf] of Object.entries(mData.providers)) {
          if (pConf.models) {
            for (const m of pConf.models) {
              models.push({
                id: m.id,
                alias: m.name || m.alias || m.id,
                provider,
                context: m.contextWindow || null,
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

// ==================== Sessions Reader ====================

function loadSessions() {
  try {
    const sessDir = CONFIG_PATH.replace('openclaw.json', 'agents/main/sessions');
    const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
    return files.map(f => {
      const id = f.replace('.jsonl', '');
      const stat = fs.statSync(`${sessDir}/${f}`);
      // Read last line for context
      let channel = 'direct', lastLine = '';
      try {
        const content = fs.readFileSync(`${sessDir}/${f}`, 'utf8');
        const lines = content.trim().split('\n').filter(Boolean);
        if (lines.length > 0) {
          lastLine = lines[lines.length - 1];
          const parsed = JSON.parse(lastLine);
          channel = parsed.channel || parsed.chatType || 'direct';
        }
      } catch {}
      return {
        id,
        channel,
        lastActivity: stat.mtime.toISOString(),
        size: stat.size
      };
    }).sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
  } catch {
    return [];
  }
}

// ==================== Tasks Persistence ====================

const TASKS_PATH = CONFIG_PATH.replace('openclaw.json', '') + '../../../openclaw-mission-control/tasks.json';
const TASKS_FILE = require('path').resolve(CONFIG_PATH, '../../..', 'openclaw-mission-control', 'tasks.json');

function getTasksFile() {
  // Store tasks alongside the proxy
  return require('path').join(__dirname, 'tasks.json');
}

function loadTasks() {
  const file = getTasksFile();
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Seed with data from the existing mission board
    const seed = {
      version: 1,
      lastModified: new Date().toISOString(),
      tasks: [
        { id: 'seed-1', title: 'Cotizar kit levante Toyota 4Runner', description: 'Buscar proveedores, comparar precios y tiempos de entrega para kit de levante completo.', status: 'backlog', priority: 'high', assignee: 'Wizard', label: 'ops', createdAt: '2026-02-25T12:00:00Z', updatedAt: '2026-02-25T12:00:00Z', notes: '' },
        { id: 'seed-2', title: 'Responder lead WhatsApp + agendar inspección', description: 'Contactar lead entrante, responder consulta y agendar visita de inspección del vehículo.', status: 'backlog', priority: 'urgent', assignee: 'Ritoque Assistant', label: 'sales', createdAt: '2026-02-25T12:00:00Z', updatedAt: '2026-02-25T12:00:00Z', notes: '' },
        { id: 'seed-3', title: 'Crear grid Instagram marzo', description: 'Diseñar el calendario de contenido de Instagram para marzo con fotos de proyectos y testimonios.', status: 'inprogress', priority: 'medium', assignee: 'Marketing Engine', label: 'marketing', createdAt: '2026-02-25T12:00:00Z', updatedAt: '2026-02-25T12:00:00Z', notes: '' },
        { id: 'seed-4', title: 'Revisar proveedor Lamartine - condiciones envío', description: 'Verificar condiciones de envío, costos y tiempos con proveedor Lamartine.', status: 'review', priority: 'low', assignee: 'Cristóbal', label: 'ops', createdAt: '2026-02-25T12:00:00Z', updatedAt: '2026-02-25T12:00:00Z', notes: '' },
        { id: 'seed-5', title: 'Instalación kit levante — F150 Raptor', description: 'Kit de levante instalado exitosamente en Ford F150 Raptor. Cliente satisfecho.', status: 'done', priority: 'high', assignee: 'Juan', label: 'service', createdAt: '2026-02-25T10:00:00Z', updatedAt: '2026-02-25T18:00:00Z', completedAt: '2026-02-25T18:00:00Z', notes: 'Cliente muy contento con el resultado' },
        { id: 'seed-6', title: 'Configurar Mission Control Dashboard', description: 'Dashboard web para monitorear todos los agentes, canales y tareas del negocio.', status: 'inprogress', priority: 'high', assignee: 'Claude', label: 'infra', createdAt: '2026-02-26T03:00:00Z', updatedAt: '2026-02-26T04:00:00Z', notes: '' },
        { id: 'seed-7', title: 'Definir pilares del negocio 4x4', description: 'Cris necesita detallar los pilares principales: servicios, ventas, marketing, operaciones, etc.', status: 'backlog', priority: 'urgent', assignee: 'Cris', label: 'strategy', createdAt: '2026-02-25T12:00:00Z', updatedAt: '2026-02-25T12:00:00Z', notes: 'Paso crítico para la estructura de agentes' },
        { id: 'seed-8', title: 'Configurar cron jobs de health checks', description: 'Programar checks automáticos de salud del sistema y canales cada hora.', status: 'backlog', priority: 'medium', assignee: 'Wizard', label: 'infra', createdAt: '2026-02-26T03:00:00Z', updatedAt: '2026-02-26T03:00:00Z', notes: '' }
      ],
      suggestions: [
        { id: 'sug-1', title: 'Activar canal WhatsApp', description: 'WhatsApp está deshabilitado. Activarlo permitiría atender leads directamente desde el canal más usado en Chile.', priority: 'high', label: 'channels' },
        { id: 'sug-2', title: 'Crear agente de Marketing dedicado', description: 'Un agente especializado en contenido, redes sociales y campañas publicitarias para el negocio 4x4.', priority: 'medium', label: 'agents' },
        { id: 'sug-3', title: 'Configurar Email con Maton', description: 'Habilitar canal de email para comunicación profesional con clientes y proveedores.', priority: 'medium', label: 'channels' },
        { id: 'sug-4', title: 'Implementar sistema de cotizaciones automáticas', description: 'Skill que genere cotizaciones PDF para servicios 4x4 a partir de una conversación.', priority: 'low', label: 'automation' },
        { id: 'sug-5', title: 'Backup automático de datos OpenClaw', description: 'Script cron que haga backup diario de la configuración, memorias y sesiones.', priority: 'high', label: 'infra' }
      ]
    };
    fs.writeFileSync(file, JSON.stringify(seed, null, 2));
    return seed;
  }
}

function saveTasks(data) {
  data.lastModified = new Date().toISOString();
  fs.writeFileSync(getTasksFile(), JSON.stringify(data, null, 2));
}

// ==================== HTTP Server ====================

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    return res.end();
  }

  if (!checkAuth(req)) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    // /config — local config + models
    if (url.pathname === '/config') {
      return json(res, 200, loadConfig());
    }

    // /snapshot — live gateway snapshot (health, presence, etc.)
    if (url.pathname === '/snapshot') {
      return json(res, 200, gwSnapshot || { error: 'no snapshot yet' });
    }

    // /sessions — list sessions from disk
    if (url.pathname === '/sessions') {
      return json(res, 200, { sessions: loadSessions() });
    }

    // /rpc — proxy to gateway via WebSocket
    if (url.pathname === '/rpc' && req.method === 'POST') {
      const body = await readBody(req);
      const { method: rpcMethod, args } = JSON.parse(body);

      try {
        const result = await gwCall(rpcMethod, args || {});
        return json(res, 200, result);
      } catch (e) {
        return json(res, 502, { error: e.message, method: rpcMethod });
      }
    }

    // /tasks — CRUD for task board
    if (url.pathname === '/tasks' && req.method === 'GET') {
      return json(res, 200, loadTasks());
    }
    if (url.pathname === '/tasks' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const data = loadTasks();
      const now = new Date().toISOString();
      const task = {
        id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: body.title || 'Untitled',
        description: body.description || '',
        status: body.status || 'backlog',
        priority: body.priority || 'medium',
        assignee: body.assignee || '',
        label: body.label || 'ops',
        createdAt: now,
        updatedAt: now,
        notes: body.notes || ''
      };
      data.tasks.push(task);
      saveTasks(data);
      return json(res, 201, task);
    }
    if (url.pathname.startsWith('/tasks/') && req.method === 'PATCH') {
      const taskId = url.pathname.split('/')[2];
      const body = JSON.parse(await readBody(req));
      const data = loadTasks();
      const task = data.tasks.find(t => t.id === taskId);
      if (!task) return json(res, 404, { error: 'task not found' });
      const now = new Date().toISOString();
      if (body.title !== undefined) task.title = body.title;
      if (body.description !== undefined) task.description = body.description;
      if (body.status !== undefined) {
        task.status = body.status;
        if (body.status === 'done' && !task.completedAt) task.completedAt = now;
      }
      if (body.priority !== undefined) task.priority = body.priority;
      if (body.assignee !== undefined) task.assignee = body.assignee;
      if (body.label !== undefined) task.label = body.label;
      if (body.notes !== undefined) task.notes = body.notes;
      task.updatedAt = now;
      saveTasks(data);
      return json(res, 200, task);
    }
    if (url.pathname.startsWith('/tasks/') && req.method === 'DELETE') {
      const taskId = url.pathname.split('/')[2];
      const data = loadTasks();
      data.tasks = data.tasks.filter(t => t.id !== taskId);
      saveTasks(data);
      return json(res, 200, { ok: true });
    }

    // /suggestions — accept/dismiss
    if (url.pathname.startsWith('/suggestions/') && req.method === 'POST') {
      const sugId = url.pathname.split('/')[2];
      const body = JSON.parse(await readBody(req));
      const data = loadTasks();
      const sugIdx = data.suggestions.findIndex(s => s.id === sugId);
      if (sugIdx === -1) return json(res, 404, { error: 'suggestion not found' });
      if (body.action === 'accept') {
        const sug = data.suggestions[sugIdx];
        const now = new Date().toISOString();
        data.tasks.push({
          id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          title: sug.title,
          description: sug.description,
          status: 'backlog',
          priority: sug.priority,
          assignee: '',
          label: sug.label,
          createdAt: now,
          updatedAt: now,
          notes: 'Accepted from suggestion'
        });
      }
      data.suggestions.splice(sugIdx, 1);
      saveTasks(data);
      return json(res, 200, { ok: true });
    }

    // /events — recent gateway events
    if (url.pathname === '/events') {
      return json(res, 200, { events: gwEvents });
    }

    // /health — proxy + gateway health
    if (url.pathname === '/health') {
      return json(res, 200, {
        status: 'ok',
        gateway: GATEWAY,
        gatewayConnected: gwReady,
        uptime: Math.floor((Date.now() - gwStartTime) / 1000),
        time: new Date().toISOString()
      });
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
  gwConnect();
});
