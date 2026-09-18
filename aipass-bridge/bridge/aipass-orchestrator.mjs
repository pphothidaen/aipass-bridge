#!/usr/bin/env node
// aipass-orchestrator.mjs — aipass (Claude Sonnet 5) as Orchestrator/Adapter
// File ops handled directly; Claude only for general chat

import http from 'node:http';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8788);
const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8787';
const NOUS_API = 'https://inference-api.nousresearch.com/v1';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[aipass]', ...a);

// ── Helpers ───────────────────────────────────────────────────────

function readToken() {
  try {
    const auth = JSON.parse(readFileSync(resolve(homedir(), '.hermes', 'auth.json'), 'utf8'));
    return auth?.providers?.nous?.access_token ?? '';
  } catch { return ''; }
}

async function readLocalFile(p) {
  try { return { ok: true, content: await readFile(p, 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
}

async function listDir(p) {
  try { return { ok: true, entries: await readdir(p) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

async function searchFiles(pattern, dir, glob) {
  try {
    const out = execSync(`grep -r "${pattern}" ${dir} --include="${glob}" -l || true`, { encoding: 'utf8', timeout: 15000 });
    return { ok: true, files: out.split('\n').filter(Boolean) };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function runCmd(cmd, cwd) {
  try { return { ok: true, output: execSync(cmd, { encoding: 'utf8', timeout: 30000, cwd: cwd || process.cwd() }) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function extractFilePaths(text) {
  const paths = [];
  const patterns = [
    /["'](\/[^"']+)["']/g,
    /["']([^"']+\.(?:js|ts|json|mjs|cjs|py|sh|md|txt|yaml|yml|toml|html|css|jsx|tsx|png|jpg))["']/gi,
    /(?:file|path|read|ไฟล์|อ่าน)\s+["']?([^"'\s]+)["']?/gi,
    /(\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+)/g,
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

// ── External Calls ────────────────────────────────────────────────

async function callBridge(model, messages) {
  const res = await fetch(`${BRIDGE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, messages }),
  });
  if (!res.ok) throw new Error(`bridge ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function callNous(model, prompt, system = 'You are a helpful AI assistant.') {
  const token = readToken();
  if (!token) throw new Error('No Nous token');
  const https = await import('node:https');
  const url = new URL(`${NOUS_API}/chat/completions`);
  const body = JSON.stringify({ model, stream: false, max_tokens: 2048, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] });
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: url.hostname, port: 443, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}`, 'user-agent': 'Hermes', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`Nous ${res.statusCode}: ${data.slice(0, 200)}`));
        else try { resolve(JSON.parse(data).choices?.[0]?.message?.content ?? ''); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Orchestrator ──────────────────────────────────────────────────

async function orchestrate(payload) {
  const stream = payload.stream !== false;
  const messages = payload.messages ?? [];
  const lastUser = messages.filter(m => m.role === 'user').at(-1);
  if (!lastUser) return { error: 'no user message' };

  const userContent = typeof lastUser.content === 'string'
    ? lastUser.content
    : (lastUser.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '');

  const lowerContent = userContent.toLowerCase();

  // 1. Read file (English + Thai, with or without path prefix)
  const readMatch = /(?:read|open|show|view|display|get|cat|อ่าน(?:ไฟล์)?|เปิด|แสดง)\s+(?:file\s+|path\s+|ไฟล์\s+)?["']?(\/[^"'\s]+)["']?/i.exec(userContent);
  const showPathMatch = /(?:show|tell|give|บอก|ให้)\s+(?:me\s+)?["']?(\/[^"'\s]+)["']?/i.exec(userContent);
  const thaiReadMatch = /(?:อ่าน|เปิด|แสดง)\s+(?:ไฟล์|เนื้อหา|ข้อมูล)?\s*["']?(\/[^"'\s]+)["']?/i.exec(userContent);
  const bareFileMatch = /(?:read|open|show|view|display|อ่าน|เปิด|แสดง)\s+(?:file\s+)?["']?([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)["']?/i.exec(userContent);
  const fileRequest = readMatch || showPathMatch || thaiReadMatch;
  const bareFile = bareFileMatch?.[1];

  if (fileRequest || bareFile || /(?:read|open|show|อ่าน|เปิด|แสดง)\s+\/(?:tmp|home|Users|etc|var|usr)/i.test(userContent)) {
    const singlePath = fileRequest?.[1];
    let allPaths = extractFilePaths(userContent);
    if (singlePath && !allPaths.includes(singlePath)) allPaths.unshift(singlePath);
    if (bareFile) {
      const candidates = [];
      // Prefer files closer to the project root (home/Projects/project/)
      const commonRoots = [
        resolve(homedir(), 'Project', 'aipass-web-bridge'),
        resolve(homedir(), 'Projects', 'aipass-web-bridge'),
      ];
      for (const root of commonRoots) {
        candidates.push(resolve(root, bareFile));
      }
      // Then search upward from cwd
      let dir = process.cwd();
      const root = homedir();
      while (dir.startsWith(root) || dir.startsWith('/Users')) {
        candidates.push(resolve(dir, bareFile));
        if (dir === root || dir === '/') break;
        dir = dirname(dir);
      }
      // Check which candidate exists - only add the FIRST match (project root)
      for (const candidate of candidates) {
        const result = await readLocalFile(candidate);
        if (result.ok) {
          allPaths.unshift(candidate);
          break; // Stop at first match (project root)
        }
      }
      // After finding the bare file, DON'T add other matches from extractFilePaths
      // Clear any other matches that might have been added by extractFilePaths
      allPaths = allPaths.slice(0, 1);
    }
    let response = '';
    for (const fp of allPaths) {
      const result = await readLocalFile(fp);
      response += result.ok
        ? `📄 **${fp}:**\n\n\`\`\`\n${result.content}\n\`\`\`\n\n`
        : `❌ **${fp}:** ${result.error}\n\n`;
    }
    if (response) return { content: response.trim(), stream };
  }

  // 2. List directory
  if (/(?:list|show|what(?:'s| is)\s+in|แสดงรายการ)\s+(?:files?\s+in\s+)?["']?(\/[^"'\s]+)["']?/i.test(userContent) || /list\s+(?:files|directory|folder|dir|ไฟล์|โฟลเดอร์)/i.test(lowerContent)) {
    const dirMatch = /["']?(\/[^"'\s]+)["']?/i.exec(userContent);
    const dirPath = dirMatch?.[1] || '/tmp';
    const result = await listDir(dirPath);
    if (result.ok) return { content: `📂 **${dirPath}/** (${result.entries.length} items):\n\n${result.entries.join('\n')}`, stream };
    return { content: `❌ Directory not found: ${dirPath}\n${result.error}`, stream };
  }

  // 3. Search files
  if (/(?:search|find|grep|look\s+for|ค้นหา)\s+["']?([^"']+?)["']?\s+(?:in|inside|within|ใน)\s+(\S+)/i.test(userContent) || /(?:search|find|grep|ค้นหา)\s+for/i.test(lowerContent)) {
    const searchMatch = /(?:search|find|grep|ค้นหา)\s+["']?([^"']+?)["']?\s+(?:in|inside|within|ใน)\s+(\S+)/i.exec(userContent);
    const pattern = searchMatch?.[1] || '';
    const dirPath = searchMatch?.[2] || '.';
    const result = await searchFiles(pattern, dirPath, '*');
    if (result.ok) return { content: `🔍 **Search "${pattern}" in ${dirPath}:**\n\n${result.files.join('\n') || 'No matches found'}`, stream };
  }

  // 4. Run command (supports cd, grep, find, etc.)
  if (/^(?:run|execute|cmd|command|shell|bash|รัน)\s+/i.test(lowerContent)) {
    const cmd = userContent.replace(/^(?:run|execute|cmd|command|shell|bash|รัน)\s+/i, '').trim();
    const result = await runCmd(cmd);
    if (result.ok) return { content: `💻 **Command:** \`${cmd}\`\n\n\`\`\`\n${result.output}\n\`\`\``, stream };
    return { content: `❌ Command failed: ${result.error}`, stream };
  }

  // 4b. Quick grep/search in files
  if (/^(?:grep|search|find|ค้นหา)\s+/i.test(lowerContent)) {
    let pattern = '';
    let dir = '.';
    const grepMatch = userContent.match(/(?:grep|search|find|ค้นหา)\s+["']?([^"']+)["']?(?:\s+in\s+["']?([^"']+)["']?)?/i);
    if (grepMatch) {
      pattern = grepMatch[1];
      if (grepMatch[2]) dir = grepMatch[2];
    }
    if (pattern) {
      const result = await searchFiles(pattern, dir, '*');
      if (result.ok) return { content: `🔍 **grep "${pattern}" in ${dir}:**\n\n${result.files.join('\n') || 'No matches found'}`, stream };
    }
    return { content: `❌ Please specify pattern: grep "pattern" in [dir]`, stream };
  }

  // 5. File write/edit/create → handle directly
    if (/^(?:write|edit|create|แก้ไข|เขียน|สร้าง)\s+/i.test(lowerContent)) {
      const fileMatch = /["']?(\/[^"'\s]+)["']?/i.exec(userContent);
      const filePath = fileMatch?.[1];
      if (filePath) {
        // Extract content from user request
        let newContent = '';
        const contentMatch = userContent.match(/(?:with content|content|เนื้อหา|content:|เนื้อหา:)[:\s]+(.+)$/i);
        if (contentMatch) newContent = contentMatch[1].trim();
      
        if (newContent) {
          await writeFile(filePath, newContent);
          return { content: `✅ Written to ${filePath}`, stream };
        }
      
        // No content provided — show current and ask
        let existingContent = '';
        try { const r = await readLocalFile(filePath); if (r.ok) existingContent = r.content; } catch { /* new file */ }
        return { content: `📝 **File Write Request:** ${filePath}\n\nCurrent content:\n\`\`\`\n${existingContent || '(new file)'}\n\`\`\`\n\nPlease specify content: "write [path] with content: [your content]"`, stream };
      }
    }

  // 6. Default: Bridge (Claude) → fallback to Nous for general chat only
  try {
    const reply = await callBridge('claude-sonnet-5@default', [
      { role: 'system', content: 'You are a helpful AI assistant. Provide clear and concise answers.' },
      { role: 'user', content: userContent },
    ]);
    return { content: reply, stream };
  } catch (err) {
    log(`Bridge unavailable, fallback to Nous for general chat: ${err.message.slice(0, 80)}`);
    try {
      const result = await callNous('meituan/longcat-2.0:free', userContent);
      return { content: result, stream };
    } catch (nousErr) {
      return { content: `All providers unavailable: ${err.message.slice(0, 100)}`, stream };
    }
  }
}

// ── HTTP Server ───────────────────────────────────────────────────

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); return; } parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

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
        return json(res, 200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: result.content }, finish_reason: 'stop' }] });
      }
    } catch (err) {
      log(`Error: ${err.message}`);
      return json(res, 500, { error: { message: err.message } });
    }
    return;
  }

  return json(res, 404, { error: { message: `no route for ${req.method} ${urlPath}` } });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`aipass-orchestrator (inversion) on :${PORT}`);
  log('Ready...');
});

export { orchestrate, extractFilePaths, readLocalFile, listDir, searchFiles, runCmd };
