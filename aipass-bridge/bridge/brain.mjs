#!/usr/bin/env node
// brain.mjs — Team 1: aipass (Claude Sonnet 5) as Orchestrator Brain
// Uses file-based task queue (/tmp/tasks/ → workers → /tmp/results/)
// Dynamically selects Nous worker models based on task domain

import http from 'node:http';
import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const PORT = Number(process.env.BRAIN_PORT ?? 8789);
const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8787';
const TASKS_DIR = process.env.TASKS_DIR ?? '/tmp/aipass-tasks';
const RESULTS_DIR = process.env.RESULTS_DIR ?? '/tmp/aipass-results';
const DONE_DIR = `${TASKS_DIR}/done`;
const MAX_ROUNDS = 8;
const ROUND_TIMEOUT = 120000;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[brain]', ...a);

await mkdir(TASKS_DIR, { recursive: true });
await mkdir(RESULTS_DIR, { recursive: true });
await mkdir(DONE_DIR, { recursive: true });

function readNousToken() {
  try {
    const auth = JSON.parse(readFileSync(resolve(homedir(), '.hermes', 'auth.json'), 'utf8'));
    return auth?.providers?.nous?.access_token ?? '';
  } catch { return ''; }
}

function selectModelForTask(taskType, request) {
  const req = request.toLowerCase();
  if (/image|vision|visual|photo|picture|ภาพ|มอง|ดูภาพ|screenshot|canvas/i.test(req))
    return 'stepfun/step-3.7-flash';
  if (/finance|invest|stock|portfolio|การเงิน|ลงทุน|หุ้น|tax|budget|asset/i.test(req))
    return 'inclusionai/ling-3.0-flash-fin';
  if (/medical|health|diagnosis|patient|symptom|disease|condition|แพทย์|สุขภาพ|อาการ|โรค|drug|treatment/i.test(req))
    return 'inclusionai/ling-3.0-flash-sante';
  if (/terminal|command|run|execute|shell|bash|cmd|คำสั่ง|grep|find|npm|node/i.test(req))
    return 'upstage/solar-pro-4';
  if (/quick|fast|small|เร็ว|เล็ก/i.test(req) && /code|fix|write|แก้|เขียน|patch/i.test(req))
    return 'poolside/laguna-s-2.1';
  if (/multi[- ]step|complex|workflow|pipeline|multi[- ]stage/i.test(req))
    return 'upstage/solar-pro-4';
  if (/prove|theorem|logic|mathematics|derive|proof|analyze|calculate|วิเคราะห์|คำนวณ|reason/i.test(req))
    return 'upstage/solar-pro-4';
  return 'meituan/longcat-2.0:free';
}

let taskIdCounter = Date.now();

async function dispatchTask({ type, payload, model }) {
  const id = `task-${++taskIdCounter}`;
  const task = { id, type, payload, model, createdAt: Date.now() };
  await writeFile(`${TASKS_DIR}/${id}.json`, JSON.stringify(task, null, 2));
  log(`Dispatched: ${id} -> ${model} (${type})`);
  return id;
}

async function getResult(id) {
  const resultPath = `${RESULTS_DIR}/${id}.json`;
  if (!existsSync(resultPath)) return null;
  try {
    const data = JSON.parse(await readFile(resultPath, 'utf8'));
    await unlink(resultPath).catch(() => {});
    return data;
  } catch { return null; }
}

async function waitForResult(id, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const r = await getResult(id);
    if (r) return r;
    await new Promise(r => setTimeout(r, 500));
  }
  return { status: 'timeout' };
}

const SYSTEM_PROMPT = `You are an ORCHESTRATOR AI. You analyze requests and return ONLY JSON.

AVAILABLE ACTIONS:
- Read a file:   {"action":"read_file","path":"/absolute/path"}
- List a dir:    {"action":"list_dir","path":"/absolute/path"}
- Search files:  {"action":"search_files","pattern":"text","path":"dir/","glob":"*.js"}
- Run command:   {"action":"run_command","command":"ls -la"}
- AI task:       {"action":"ai_task","prompt":"what to ask","domain":"coding"}
- Respond:       {"action":"respond","content":"your answer"}

DOMAINS FOR AI TASKS (select best model):
- "coding" -> meituan/longcat-2.0:free (general coding)
- "finance" -> inclusionai/ling-3.0-flash-fin (investment, portfolio)
- "medicine" -> inclusionai/ling-3.0-flash-sante (clinical, health)
- "vision" -> stepfun/step-3.7-flash (image analysis, visual search)
- "terminal" -> upstage/solar-pro-4 (commands, multi-step)
- "fast-coding" -> poolside/laguna-s-2.1 (quick code fixes)

RULES:
1. ALWAYS use {"action":"read_file","path":"..."} when asked to read files - the system reads it for you
2. DO NOT say "I cannot read files" - file access is automatic
3. For AI tasks, specify the domain so the best model is selected
4. Return ONLY the JSON object, no markdown, no code blocks
5. After getting file content or AI results, analyze and use {"action":"respond","content":"..."}`;

async function callAipass(messages) {
  const res = await fetch(`${BRIDGE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5@default', stream: false, messages }),
  });
  if (!res.ok) throw new Error(`Bridge returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function extractAction(text) {
  try {
    const m = text.match(/\{[\s\S]*?\}/);
    if (m) return JSON.parse(m[0]);
  } catch { /* ignore */ }
  return { action: 'respond', content: text };
}

function extractFilePaths(text) {
  const paths = [];
  const patterns = [
    /["'](\/[^"']+)["']/g,
    /["']([^"']+\.(?:js|ts|json|mjs|cjs|py|sh|md|txt|yaml|yml|toml|html|css|jsx|tsx|png|jpg|jpeg|gif|svg))["']/gi,
    /file\s+["']?([^"'\s]+)["']?/gi,
    /path\s+["']?([^"'\s]+)["']?/gi,
    /read\s+["']?([^"'\s]+)["']?/gi,
    /open\s+["']?([^"'\s]+)["']?/gi,
    /load\s+["']?([^"'\s]+)["']?/gi,
    /([a-zA-Z]:[\\/][^\s"':]+)/g,
    /\.\w+(?:\.\w+)?/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const candidate = m[1];
      if (candidate && !paths.includes(candidate)) paths.push(candidate);
    }
  }
  // Filter: skip bare words that look like code identifiers (too short relative to a path)
  return paths.filter(p => !/^[a-z_][a-z0-9_]{1,15}$/.test(p));
}

async function readFilesAuto(paths) {
  const results = [];
  for (const fp of paths) {
    const tid = await dispatchTask({
      type: 'read_file',
      payload: { path: fp },
      model: 'meituan/longcat-2.0:free',
    });
    const r = await waitForResult(tid, 30000);
    if (r.status === 'completed' && r.result) {
      const resultText = typeof r.result === 'object' ? JSON.stringify(r.result, null, 2) : r.result;
      results.push({ path: fp, content: resultText, ok: true });
    } else {
      results.push({ path: fp, content: null, ok: false, error: r.error || 'timeout' });
    }
  }
  return results;
}

const CANNOT_PATTERNS = [
  /ไม่สามารถเข้าถึงไฟล์/i,
  /ไม่สามารถ.*อ่าน.*ไฟล์/i,
  /ไม่มี.*สิทธิ์.*เข้าถึง/i,
  /ไม่.*อ่าน.*ไฟล์.*ได้/i,
  /เข้าถึง.*ไฟล์.*ไม่.*ได้/i,
  /cannot access.*files?/i,
  /can'?t.*access.*files?/i,
  /don'?t.*have.*access/i,
  /no.*file.*access/i,
  /unable.*to.*read/i,
  /don'?t.*have.*the.*ability.*to.*read/i,
  /don'?t.*have.*direct.*access/i,
  /i\s+(do\s+not|don'?t)\s+have\s+(permission|access|ability)\s+to\s+read/i,
  /i\s+cannot\s+(access|read)\s+(the\s+)?file/i,
  /access\s+denied/i,
  /permission\s+denied/i,
  /can'?t\s+(open|read)\s+(the\s+)?file/i,
  /not\s+(able|permitted|allowed)\s+to\s+(access|read)/i,
];

function brainSaysCannot(text) {
  return CANNOT_PATTERNS.some(re => re.test(text));
}

async function processRequest(request) {
  log(`\n${'='.repeat(60)}`);
  log(`Request: ${request.slice(0, 120)}`);
  log('='.repeat(60));

  const brainMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: request },
  ];

  const potentialPaths = extractFilePaths(request);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    log(`-- Round ${round + 1}/${MAX_ROUNDS} --`);

    let reply;
    try {
      reply = await callAipass(brainMessages);
    } catch (err) {
      log(`aipass error: ${err.message}`);
      return { error: `aipass unavailable: ${err.message}` };
    }

    log(`Reply: ${reply.slice(0, 250)}`);

    if (brainSaysCannot(reply)) {
      log('Brain says cannot access -> auto-reading files...');

      // Collect ALL paths: from request + from reply (aipass may mention paths in its reply)
      let allPaths = [...potentialPaths];
      const replyPaths = extractFilePaths(reply);
      for (const p of replyPaths) {
        if (!allPaths.includes(p)) allPaths.push(p);
      }

      // If still no paths, try harder from the reply
      const paths = allPaths.length > 0 ? allPaths : extractFilePaths(reply);

      if (paths.length > 0) {
        // Read ALL files (not just first), collect results
        const fileResults = await readFilesAuto(paths);
        const fileContents = fileResults.filter(r => r.ok).map(r => r.content).join('\n\n---\n\n');
        const fileErrors = fileResults.filter(r => !r.ok).map(r => `Failed to read "${r.path}": ${r.error}`).join('\n');

        if (fileContents) {
          brainMessages.push(
            { role: 'assistant', content: reply },
            { role: 'user', content: `File content(s) of ${paths.length} file(s):\n\n${fileContents}\n\nNow analyze this and respond to the original request.` }
          );
          continue;
        }
        if (fileErrors) {
          brainMessages.push(
            { role: 'assistant', content: reply },
            { role: 'user', content: `File read errors:\n${fileErrors}\n\nYou said you cannot access files, but these paths were found. Try again with explicit read_file action.` }
          );
          continue;
        }
        return { result: reply };
      }
      // No paths found anywhere — still return the reply for now
      return { result: reply };
    }

    const action = extractAction(reply);

    if (action.action === 'respond') {
      log(`Final response (${action.content?.length ?? 0} chars)`);
      return { result: action.content };
    }

    if (action.action === 'read_file') {
      const tid = await dispatchTask({
        type: 'read_file',
        payload: { path: action.path },
        model: 'meituan/longcat-2.0:free',
      });
      const r = await waitForResult(tid, 30000);
      if (r.status === 'completed') {
        // Convert result to string for aipass
        const resultText = typeof r.result === 'object' ? JSON.stringify(r.result, null, 2) : r.result;
        brainMessages.push(
          { role: 'assistant', content: reply },
          { role: 'user', content: `File content of "${action.path}":\n\n${resultText}\n\nNow analyze this and respond to the original request.` }
        );
        continue;
      }
      return { error: r.error || 'timeout' };
    }

    if (action.action === 'list_dir') {
      const tid = await dispatchTask({
        type: 'list_dir',
        payload: { path: action.path || '.' },
        model: 'meituan/longcat-2.0:free',
      });
      const r = await waitForResult(tid, 30000);
      if (r.status === 'completed') {
        brainMessages.push(
          { role: 'assistant', content: reply },
          { role: 'user', content: `Directory listing of "${action.path || '.'}":\n${Array.isArray(r.result) ? r.result.join('\n') : JSON.stringify(r.result)}` }
        );
        continue;
      }
      return { error: r.error || 'timeout' };
    }

    if (action.action === 'search_files') {
      const tid = await dispatchTask({
        type: 'search_files',
        payload: { pattern: action.pattern, path: action.path, glob: action.glob },
        model: 'upstage/solar-pro-4',
      });
      const r = await waitForResult(tid, 60000);
      if (r.status === 'completed') {
        brainMessages.push(
          { role: 'assistant', content: reply },
          { role: 'user', content: `Search results:\n${JSON.stringify(r.result)}` }
        );
        continue;
      }
      return { error: r.error || 'timeout' };
    }

    if (action.action === 'run_command') {
      const tid = await dispatchTask({
        type: 'run_command',
        payload: { command: action.command, timeout: action.timeout, cwd: action.cwd },
        model: 'upstage/solar-pro-4',
      });
      const r = await waitForResult(tid, 60000);
      if (r.status === 'completed') {
        brainMessages.push(
          { role: 'assistant', content: reply },
          { role: 'user', content: `Command output:\n${r.result}` }
        );
        continue;
      }
      return { error: r.error || 'timeout' };
    }

    if (action.action === 'ai_task') {
      const model = selectModelForTask('ai_task', action.domain || action.prompt || request);
      log(`AI task -> domain="${action.domain ?? 'auto'}" -> ${model}`);

      const tid = await dispatchTask({
        type: 'ai_task',
        payload: { prompt: action.prompt, system: action.system, request: request },
        model,
      });
      const r = await waitForResult(tid, 120000);
      if (r.status === 'completed') {
        brainMessages.push(
          { role: 'assistant', content: reply },
          { role: 'user', content: `Worker (${model}) response:\n${r.result}\n\nNow analyze this and respond to the original request.` }
        );
        continue;
      }
      return { error: r.error || 'timeout' };
    }

    return { result: reply };
  }

  return { error: 'Max rounds reached' };
}

const server = http.createServer(async (req, res) => {
  const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && urlPath === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, service: 'brain', port: PORT, bridge: BRIDGE,
      tasksDir: TASKS_DIR, resultsDir: RESULTS_DIR,
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
  log(`BRAIN ORCHESTRATOR (Team 1) - aipass (Claude Sonnet 5)`);
  log(`Port: ${PORT}`);
  log(`Bridge: ${BRIDGE}`);
  log(`Tasks: ${TASKS_DIR}`);
  log(`Results: ${RESULTS_DIR}`);
  log('Waiting for workers to process tasks...');
});
