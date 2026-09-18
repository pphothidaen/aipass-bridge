#!/usr/bin/env node
// worker.mjs — Team 2: Dynamic Nous model workers
// Polls /tmp/tasks/{model}/ → executes → writes to /tmp/results/
// Supports all 7 Nous worker models

import { readFile, writeFile, readdir, mkdir, unlink, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const MODEL = process.env.MODEL || 'meituan/longcat-2.0:free';
const TASKS_DIR = process.env.TASKS_DIR || '/tmp/aipass-tasks';
const RESULTS_DIR = process.env.RESULTS_DIR || '/tmp/aipass-results';
const NOUS_API = 'https://inference-api.nousresearch.com/v1';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), `[worker:${MODEL}]`, ...a);

await mkdir(TASKS_DIR, { recursive: true });
await mkdir(RESULTS_DIR, { recursive: true });

function readNousToken() {
  try {
    const auth = JSON.parse(readFileSync(resolve(homedir(), '.hermes', 'auth.json'), 'utf8'));
    return auth?.providers?.nous?.access_token ?? '';
  } catch { return ''; }
}

async function callNousModel(model, messages, maxTokens = 2048) {
  const token = readNousToken();
  if (!token) throw new Error('No Nous token available');

  const https = await import('node:https');
  const url = new URL(`${NOUS_API}/chat/completions`);
  const body = JSON.stringify({
    model,
    stream: false,
    max_tokens: maxTokens,
    messages,
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

async function executeTask(task) {
  const { id, type, payload, model } = task;

  // File operations (local — no model needed)
  if (type === 'read_file') {
    try {
      const content = await readFile(payload.path, 'utf8');
      return content;  // Return just the string content
    } catch (err) {
      return { error: err.message, path: payload.path };
    }
  }

  if (type === 'write_file') {
    try {
      await writeFile(payload.path, payload.content);
      return { written: true, path: payload.path };
    } catch (err) {
      return { error: err.message };
    }
  }

  if (type === 'list_dir') {
    try {
      const entries = await readdir(payload.path || '.');
      return { entries, count: entries.length, path: payload.path || '.' };
    } catch (err) {
      return { error: err.message };
    }
  }

  if (type === 'search_files') {
    try {
      const cmd = `grep -r "${payload.pattern}" ${payload.path || '.'} --include="${payload.glob || '*'}" -l || true`;
      const output = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
      const files = output.split('\n').filter(Boolean);
      return { files, pattern: payload.pattern };
    } catch (err) {
      return { error: err.message };
    }
  }

  if (type === 'run_command') {
    try {
      const output = execSync(payload.command, {
        encoding: 'utf8',
        timeout: payload.timeout || 30000,
        cwd: payload.cwd || process.cwd(),
      });
      return { output, command: payload.command };
    } catch (err) {
      return { error: err.message };
    }
  }

  // AI tasks — call Nous model
  if (type === 'ai_task') {
    const workerModel = model || MODEL;
    try {
      const systemPrompt = payload.system || 'You are a helpful assistant. Provide accurate and concise responses.';
      const userPrompt = payload.prompt;
      const result = await callNousModel(workerModel, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], payload.maxTokens || 2048);
      return { result, model: workerModel };
    } catch (err) {
      return { error: err.message, model: workerModel };
    }
  }

  return { error: `unknown task type: ${type}` };
}

// ── Poll loop ────────────────────────────────────────────────────────

async function pollTasks() {
  try {
    const entries = await readdir(TASKS_DIR);
    const taskFiles = entries.filter(f => f.endsWith('.json') && f.startsWith('task-'));

    for (const file of taskFiles) {
      const filePath = `${TASKS_DIR}/${file}`;
      let task;
      try {
        task = JSON.parse(await readFile(filePath, 'utf8'));
      } catch { continue; }

      // Check if this task is for us (by model)
      if (task.model && task.model !== MODEL) continue;

      // Claim the task
      await unlink(filePath).catch(() => {});
      log(`Task ${task.id} (${task.type})`);

      const result = await executeTask(task);
      const resultData = {
        taskId: task.id,
        model: MODEL,
        status: result.error ? 'failed' : 'completed',
        result: result.error ? null : result,
        error: result.error || null,
        completedAt: Date.now(),
      };

      await writeFile(`${RESULTS_DIR}/${task.id}.json`, JSON.stringify(resultData, null, 2));
      log(`Done ${task.id}`);
    }
  } catch (err) {
    log(`Poll error: ${err.message}`);
  }
}

// ── Start polling ────────────────────────────────────────────────────

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 2000);
log(`Started, polling ${TASKS_DIR} every ${POLL_INTERVAL}ms`);

while (true) {
  await pollTasks();
  await new Promise(r => setTimeout(r, POLL_INTERVAL));
}
