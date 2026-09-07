#!/usr/bin/env node
// aipass-orchestrator.mjs — UNIFIED Provider
// Inversion approach: Don't inject text into Claude — return files directly

import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const PORT = Number(process.env.PORT ?? 8788);
const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8787';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[aipass]', ...a);

function readNousToken() {
  try {
    const auth = JSON.parse(readFileSync(resolve(homedir(), '.hermes', 'auth.json'), 'utf8'));
    return auth?.providers?.nous?.access_token ?? '';
  } catch { return ''; }
}

async function readLocalFile(path) {
  try {
    const content = await readFile(path, 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function listLocalDir(path) {
  try {
    const entries = await readdir(path || '.');
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function searchLocalFiles(pattern, path, glob) {
  try {
    const cmd = `grep -r "${pattern}" ${path || '.'} --include="${glob || '*'}" -l || true`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    return { ok: true, files: output.split('\n').filter(Boolean) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function runLocalCommand(command, cwd) {
  try {
    const output = execSync(command, { encoding: 'utf8', timeout: 30000, cwd: cwd || process.cwd() });
    return { ok: true, output };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Call aipass (no injection — pure) ────────────────────────────────

async function callAipass(messages) {
  const res = await fetch(`${BRIDGE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5@default', stream: false, messages }),
  });
  if (!res.ok) throw new Error(`bridge ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ── Extract file paths ───────────────────────────────────────────────

function extractFilePaths(text) {
  const paths = [];
  const patterns = [
    /["'](\/[^"']+)["']/g,
    /["']([^"']+\.(?:js|ts|json|mjs|cjs|py|sh|md|txt|yaml|yml|toml|html|css|jsx|tsx|png|jpg))["']/gi,
    /file\s+["']?([^"'\s]+)["']?/gi,
    /path\s+["']?([^"'\s]+)["']?/gi,
    /read\s+["']?([^"'\s]+)["']?/gi,
    /(\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\.[a-zA-Z]+)?)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const p = m[1];
      if (p && !paths.includes(p) && p.length > 1 && !p.includes(' ')) paths.push(p);
    }
  }
  return paths;
}

// ── Main Orchestration (Inversion Approach) ─────────────────────────

async function orchestrate(payload) {
  const stream = payload.stream !== false;
  const messages = payload.messages ?? [];
  const lastUser = messages.filter(m => m.role === 'user').at(-1);
  if (!lastUser) return { error: 'no user message' };

  const userContent = typeof lastUser.content === 'string'
    ? lastUser.content
    : (lastUser.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '');

  const lowerContent = userContent.toLowerCase();

  // ── INVERSION: Detect files FIRST, handle directly, skip Claude ──

  // 1. Read file request (supports multiple files)
  const readMatch = /(?:read|open|show|view|display|get|cat)\s+(?:file\s+|path\s+)?["']?(\/[^"'\s]+)["']?/i.exec(userContent);
  const showPathMatch = /(?:show|tell|give)\s+(?:me\s+)?["']?(\/[^"'\s]+)["']?/i.exec(userContent);
  const fileRequest = readMatch || showPathMatch;
  if (fileRequest || /(?:read|open|show)\s+\/(?:tmp|home|Users|etc|var|usr)/i.test(userContent)) {
    const allPaths = extractFilePaths(userContent);
    const singlePath = fileRequest?.[1];
    if (singlePath && !allPaths.includes(singlePath)) allPaths.unshift(singlePath);
    let response = '';
    for (const filePath of allPaths) {
      const result = await readLocalFile(filePath);
      if (result.ok) {
        response += `📄 **${filePath}:**\n\n\`\`\`\n${result.content}\n\`\`\`\n\n`;
      } else {
        response += `❌ **${filePath}:** ${result.error}\n\n`;
      }
    }
    if (response) {
      return { content: response.trim(), stream };
    }
  }

  // 2. List directory request
  const listMatch = /(?:list|show|what(?:'s| is)\s+in)\s+(?:files?\s+in\s+)?["']?(\/[^"'\s]+)["']?/i.exec(userContent);
  if (listMatch || /list\s+(?:files|directory|folder|dir)/i.test(lowerContent)) {
    const dirPath = listMatch?.[1] || extractFilePaths(userContent)[0] || '/tmp';
    const result = await listLocalDir(dirPath);
    if (result.ok) {
      return { content: `📂 **${dirPath}/** (${result.entries.length} items):\n\n${result.entries.join('\n')}`, stream };
    }
    return { content: `❌ Directory not found: ${dirPath}\n\nError: ${result.error}`, stream };
  }

  // 3. Search request
  const searchMatch = /(?:search|find|grep|look\s+for)\s+["']?([^"']+?)["']?\s+(?:in|inside|within)\s+(\S+)/i.exec(userContent);
  if (searchMatch || /(?:search|find|grep)\s+for/i.test(lowerContent)) {
    const pattern = searchMatch?.[1] || '';
    const dirPath = searchMatch?.[2] || '.';
    const result = await searchLocalFiles(pattern, dirPath, '*');
    if (result.ok) {
      return { content: `🔍 **Search "${pattern}" in ${dirPath}:**\n\n${result.files.join('\n') || 'No matches found'}`, stream };
    }
  }

  // 4. Run command
  if (/^(?:run|execute|cmd|command|shell|bash)\s+/i.test(lowerContent)) {
    const cmd = userContent.replace(/^(?:run|execute|cmd|command|shell|bash)\s+/i, '').trim();
    const result = await runLocalCommand(cmd);
    if (result.ok) {
      return { content: `💻 **Command:** \`${cmd}\`\n\n\`\`\`\n${result.output}\n\`\`\``, stream };
    }
    return { content: `❌ Command failed: ${result.error}`, stream };
  }

  // 5. Default: Pass to Claude
  try {
    const reply = await callAipass([
      { role: 'system', content: 'You are a helpful AI assistant. Provide clear and concise answers.' },
      { role: 'user', content: userContent },
    ]);
    return { content: reply, stream };
  } catch (err) {
    return { content: `aipass unavailable: ${err.message}`, stream };
  }
}

// ── HTTP Server ─────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname.replace(/\/+$/, '') || '/';

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && (urlPath === '/health' || urlPath === '/status')) {
    return json(res, 200, { ok: true, service: 'aipass-orchestrator', port: PORT, bridge: BRIDGE });
  }

  if (req.method === 'GET' && urlPath === '/v1/models') {
    return json(res, 200, {
      object: 'list',
      data: [
        { id: 'claude-sonnet-5@default', object: 'model', created: 0, owned_by: 'aipass' },
        { id: 'meituan/longcat-2.0:free', object: 'model', created: 0, owned_by: 'nous' },
      ],
    });
  }

  if (req.method === 'POST' && urlPath === '/v1/chat/completions') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: { message: 'invalid JSON' } }); }

    const stream = payload.stream !== false;

    try {
      const result = await orchestrate(payload);
      if (result.error) return json(res, 400, { error: { message: result.error } });

      const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      const created = Math.floor(Date.now() / 1000);
      const model = payload.model || 'claude-sonnet-5@default';

      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: result.content } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        return json(res, 200, { id, object: 'chat.completion', created, model,
          choices: [{ index: 0, message: { role: 'assistant', content: result.content }, finish_reason: 'stop' }] });
      }
    } catch (err) {
      return json(res, 500, { error: { message: err.message } });
    }
    return;
  }

  return json(res, 404, { error: { message: 'not found' } });
});

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); return; } parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

server.listen(PORT, '127.0.0.1', () => {
  log(`aipass-orchestrator (inversion approach) on :${PORT}`);
  log('Ready...');
});
