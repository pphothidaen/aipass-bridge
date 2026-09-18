#!/usr/bin/env node
// autonomous-system.mjs — Full autonomous brain-worker system
// WITH dynamic model dispatch + auto file access loop
//
// Team 1: Brain (aipass/Claude Sonnet 5) — orchestrates, plans, analyzes
// Team 2: Workers (7 Nous models) — execute tasks by domain specialty

import http from 'node:http';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const PORT = Number(process.env.PORT ?? 8789);
const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8788';
const NOUS_API = 'https://inference-api.nousresearch.com/v1';
const MAX_BRAIN_ROUNDS = 5;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[system]', ...a);

// ── Nous Token ────────────────────────────────────────────────────────

function readNousToken() {
  try {
    const auth = JSON.parse(readFileSync(resolve(homedir(), '.hermes', 'auth.json'), 'utf8'));
    return auth?.providers?.nous?.access_token ?? '';
  } catch { return ''; }
}

// ── Worker Model Registry ─────────────────────────────────────────────

const WORKER_MODELS = {
  'meituan/longcat-2.0:free': {
    id: 'meituan/longcat-2.0:free',
    domain: 'coding',
    skills: ['coding', 'general', 'agentic', 'long-context'],
    context: 131072,
    free: true,
  },
  'upstage/solar-pro-4': {
    id: 'upstage/solar-pro-4',
    domain: 'multi-step',
    skills: ['multi-step', 'terminal', 'tool-calls', 'document-analysis'],
    context: 524000,
    free: false,
  },
  'stepfun/step-3.7-flash': {
    id: 'stepfun/step-3.7-flash',
    domain: 'vision',
    skills: ['vision', 'visual-search', 'multimodal'],
    context: 131072,
    free: false,
  },
  'poolside/laguna-s-2.1': {
    id: 'poolside/laguna-s-2.1',
    domain: 'coding-fast',
    skills: ['agentic-coding', 'fast'],
    context: 131072,
    free: false,
  },
  'poolside/laguna-xs-2.1': {
    id: 'poolside/laguna-xs-2.1',
    domain: 'coding-lightweight',
    skills: ['agentic-coding', 'lightweight', 'fast'],
    context: 65536,
    free: false,
  },
  'inclusionai/ling-3.0-flash-fin': {
    id: 'inclusionai/ling-3.0-flash-fin',
    domain: 'finance',
    skills: ['finance', 'investment', 'portfolio-analysis'],
    context: 131072,
    free: false,
  },
  'inclusionai/ling-3.0-flash-sante': {
    id: 'inclusionai/ling-3.0-flash-sante',
    domain: 'medicine',
    skills: ['medicine', 'clinical', 'evidence-based'],
    context: 131072,
    free: false,
  },
};

// Model router — pick best model for task
function selectWorkerModel(taskType, request) {
  const req = request.toLowerCase();

  // Vision tasks
  if (/image|vision|visual|photo|picture|ภาพ|มอง|ดูภาพ/i.test(req)) {
    return 'stepfun/step-3.7-flash';
  }
  // Finance tasks
  if (/finance|invest|stock|portfolio|การเงิน|ลงทุน|หุ้น|portfolio/i.test(req)) {
    return 'inclusionai/ling-3.0-flash-fin';
  }
  // Medical tasks
  if (/medical|health|diagnosis|patient|แพทย์|สุขภาพ|โรค|อาการ/i.test(req)) {
    return 'inclusionai/ling-3.0-flash-sante';
  }
  // Terminal/command tasks
  if (/terminal|command|run|execute|shell|bash|cmd|คำสั่ง/i.test(req)) {
    return 'upstage/solar-pro-4';
  }
  // Fast coding
  if (/quick|fast|small|เร็ว|เล็ก/i.test(req) && /code|fix|write|แก้|เขียน/i.test(req)) {
    return 'poolside/laguna-s-2.1';
  }
  // Default: longcat (free, good at coding)
  return 'meituan/longcat-2.0:free';
}

// ── In-Memory Task Queue ──────────────────────────────────────────────

const taskQueue = [];
let taskCounter = 0;

async function dispatchAndWait({ type, payload, model = 'meituan/longcat-2.0:free' }) {
  return new Promise((resolve) => {
    const id = `task-${++taskCounter}`;
    taskQueue.push({ id, type, payload, model, resolve });
    queueMicrotask(processQueue);
  });
}

async function processQueue() {
  while (taskQueue.length > 0) {
    const task = taskQueue.shift();
    try {
      const result = await executeTask(task);
      task.resolve({ status: 'completed', result });
    } catch (err) {
      task.resolve({ status: 'failed', error: err.message });
    }
  }
}

async function executeTask(task) {
  const { type, payload, model } = task;

  // Local file operations (always done locally)
  if (type === 'read_file') {
    const content = await readFile(payload.path, 'utf8');
    return { content, size: content.length, path: payload.path };
  }
  if (type === 'write_file') {
    await writeFile(payload.path, payload.content);
    return { written: true, path: payload.path };
  }
  if (type === 'list_dir') {
    const entries = await readdir(payload.path || '.');
    return { entries, count: entries.length, path: payload.path || '.' };
  }
  if (type === 'run_command') {
    const output = execSync(payload.command, {
      encoding: 'utf8',
      timeout: payload.timeout || 30000,
      cwd: payload.cwd || process.cwd(),
    });
    return { output, command: payload.command };
  }
  if (type === 'search_files') {
    const output = execSync(
      `grep -r "${payload.pattern}" ${payload.path || '.'} --include="${payload.glob || '*'}" -l || true`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const files = output.split('\n').filter(Boolean);
    return { files, pattern: payload.pattern };
  }

  // AI tasks — dispatch to Nous model
  if (type === 'ai_task') {
    return await callNousModel(model, payload.prompt, payload.system);
  }

  throw new Error(`unknown task type: ${type}`);
}

// ── Call Nous Model ───────────────────────────────────────────────────

async function callNousModel(model, prompt, systemPrompt = 'You are a helpful assistant.') {
  const token = readNousToken();
  if (!token) throw new Error('No Nous token available');

  const https = await import('node:https');
  const url = new URL(`${NOUS_API}/chat/completions`);
  const body = JSON.stringify({
    model,
    stream: false,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`,
        'user-agent': 'Hermes',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Nous ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          resolve(json.choices?.[0]?.message?.content ?? '');
        } catch (err) {
          reject(new Error(`Parse error: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Brain (aipass) Call ───────────────────────────────────────────────

async function callAipass(messages) {
  const res = await fetch(`${BRIDGE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5@default', stream: false, messages }),
  });
  if (!res.ok) throw new Error(`Bridge returned ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ── Detect "I can't access files" ─────────────────────────────────────

const CANNOT_ACCESS_PATTERNS = [
  /ไม่สามารถเข้าถึงไฟล์/i,
  /ไม่สามารถ.*อ่าน.*ไฟล์/i,
  /ไม่มี.*สิทธิ์.*เข้าถึง/i,
  /cannot access.*files?/i,
  /can'?t.*access.*files?/i,
  /don'?t.*have.*access/i,
  /no.*file.*access/i,
  /unable.*to.*read/i,
  /don'?t.*have.*the.*ability.*to.*read/i,
  /don'?t.*have.*direct.*access/i,
];

function brainSaysCannot(text) {
  return CANNOT_ACCESS_PATTERNS.some(re => re.test(text));
}

// ── Extract file paths from request ───────────────────────────────────

function extractFilePaths(request) {
  const paths = [];
  const patterns = [
    /["'](\/[^"']+)["']/g,
    /["']([^"']+\.(?:js|ts|json|mjs|cjs|py|sh|md|txt|yaml|yml|toml|html|css|jsx|tsx))["']/gi,
    /file\s+["']?([^"'\s]+)["']?/gi,
    /path\s+["']?([^"'\s]+)["']?/gi,
    /read\s+["']?([^"'\s]+)["']?/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(request)) !== null) {
      if (!paths.includes(m[1])) paths.push(m[1]);
    }
  }
  return paths;
}

// ── Autonomous Request Processing ─────────────────────────────────────

async function processRequest(request) {
  log(`Request: ${request.slice(0, 100)}`);

  const brainMessages = [
    { role: 'system', content: `You are an ORCHESTRATOR AI that can access the local filesystem and dispatch tasks to worker models.

AVAILABLE ACTIONS (return ONLY JSON):
- Read file: {"action":"read_file","path":"/absolute/path"}
- List dir: {"action":"list_dir","path":"/absolute/path"}
- Search: {"action":"search_files","pattern":"text","path":"dir/","glob":"*.js"}
- Command: {"action":"run_command","command":"ls -la"}
- AI task: {"action":"ai_task","prompt":"what to ask","model":"meituan/longcat-2.0:free"}
- Respond: {"action":"respond","content":"your answer"}

AVAILABLE WORKER MODELS:
- meituan/longcat-2.0:free (coding, general, agentic)
- upstage/solar-pro-4 (multi-step, terminal, tool-calls, 524K context)
- stepfun/step-3.7-flash (vision, visual-search)
- poolside/laguna-s-2.1 (fast agentic coding)
- poolside/laguna-xs-2.1 (lightweight agentic coding)
- inclusionai/ling-3.0-flash-fin (finance, investment)
- inclusionai/ling-3.0-flash-sante (medicine, clinical)

CRITICAL: When asked to read a file, ALWAYS use {"action":"read_file","path":"..."} — the system reads it for you.
DO NOT say "I cannot read files" — file access is automatic.
Return ONLY the JSON object, no markdown, no code blocks.` },
  ];

  const potentialPaths = extractFilePaths(request);
  brainMessages.push({ role: 'user', content: request });

  for (let round = 0; round < MAX_BRAIN_ROUNDS; round++) {
    log(`Brain round ${round + 1}`);

    const reply = await callAipass(brainMessages);
    log(`Reply: ${reply.slice(0, 200)}`);

    // ── Auto-recover: brain says cannot access files ──
    if (brainSaysCannot(reply)) {
      log('Brain says cannot → auto-reading...');
      const pathsToRead = potentialPaths.length > 0 ? potentialPaths : extractFilePaths(request);

      if (pathsToRead.length > 0) {
        for (const filePath of pathsToRead) {
          log(`Auto-reading: ${filePath}`);
          const r = await dispatchAndWait({ type: 'read_file', payload: { path: filePath } });
          if (r.status === 'completed') {
            brainMessages.push(
              { role: 'assistant', content: reply },
              { role: 'user', content: `File content of "${filePath}":\n\n${r.result.result.content}` }
            );
            break;
          } else {
            brainMessages.push(
              { role: 'assistant', content: reply },
              { role: 'user', content: `Failed to read "${filePath}": ${r.error}` }
            );
            break;
          }
        }
        continue;
      } else {
        return { result: reply };
      }
    }

    // ── Parse JSON action ──
    let action;
    try {
      const m = reply.match(/\{[\s\S]*\}/);
      if (m) {
        action = JSON.parse(m[0]);
      } else {
        return { result: reply };
      }
    } catch {
      return { result: reply };
    }

    // ── Execute action ──
    if (action.action === 'respond') {
      return { result: action.content };
    }

    if (action.action === 'read_file') {
      const r = await dispatchAndWait({ type: 'read_file', payload: { path: action.path } });
      if (r.status === 'completed') {
        brainMessages.push(
          { role: 'assistant', content: reply },
          { role: 'user', content: `File content of "${action.path}":\n\n${r.result.result.content}\n\nNow analyze this and respond to the original request.` }
        );
        continue;
      }
      return { error: r.error };
    }

    if (action.action === 'list_dir') {
      const r = await dispatchAndWait({ type: 'list_dir', payload: { path: action.path || '.' } });
      if (r.status === 'completed') {
        brainMessages.push(
          { role: 'assistant', content: reply },
          { role: 'user', content: `Directory listing of "${action.path || '.'}":\n${r.result.result.entries.join('\n')}` }
        );
        continue;
      }
      return { error: r.error };
    }

    if (action.action === 'search_files') {
      const r = await dispatchAndWait({ type: 'search_files', payload: {
        pattern: action.pattern, path: action.path, glob: action.glob
      }});
      if (r.status === 'completed') {
        brainMessages.push(
          { role: 'assistant', content: reply },
          { role: 'user', content: `Search results:\n${r.result.result.files.join('\n')}` }
        );
        continue;
      }
      return { error: r.error };
    }

    if (action.action === 'run_command') {
      const r = await dispatchAndWait({ type: 'run_command', payload: {
        command: action.command, timeout: action.timeout, cwd: action.cwd
      }});
      if (r.status === 'completed') {
        brainMessages.push(
          { role: 'assistant', content: reply },
          { role: 'user', content: `Command output:\n${r.result.result.output}` }
        );
        continue;
      }
      return { error: r.error };
    }

    if (action.action === 'ai_task') {
      // Select model for this AI task
      const model = action.model || selectWorkerModel('ai_task', action.prompt);
      log(`Dispatching AI task to ${model}`);

      const r = await dispatchAndWait({
        type: 'ai_task',
        payload: { prompt: action.prompt, system: action.system },
        model,
      });

      if (r.status === 'completed') {
        brainMessages.push(
          { role: 'assistant', content: reply },
          { role: 'user', content: `Worker (${model}) response:\n${r.result.result}` }
        );
        continue;
      }
      return { error: r.error };
    }

    return { result: reply };
  }

  return { error: 'Max brain rounds reached' };
}

// ── HTTP Server ───────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && urlPath === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, service: 'autonomous-system', port: PORT, bridge: BRIDGE,
      uptime: process.uptime(),
    }));
  }

  if (req.method === 'POST' && urlPath === '/process') {
    let body = '';
    req.on('data', d => body += d);
    await new Promise(r => req.on('end', r));

    let request;
    try {
      request = JSON.parse(body || '{}').request;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid JSON' }));
    }

    if (!request) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'request is required' }));
    }

    try {
      const result = await processRequest(request);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      log(`Error: ${err.message}`);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  log(`╔══════════════════════════════════════════════╗`);
  log(`║  Autonomous Brain-Worker System              ║`);
  log(`║  Brain: aipass (Claude Sonnet 5)            ║`);
  log(`║  Workers: 7 Nous models                     ║`);
  log(`╠══════════════════════════════════════════════╣`);
  log(`║  Port:    ${PORT}                                ║`);
  log(`║  Bridge:  ${BRIDGE}        ║`);
  log(`╚══════════════════════════════════════════════╝`);
  log('Ready...');
});
