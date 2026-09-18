#!/usr/bin/env node
// brain-orchestrator.mjs — aipass (Claude Sonnet 5) เป็น Brain วางแผน + สั่งงาน Workers
//
// Architecture:
//   User → Brain (aipass) → วิเคราะห์ → สร้าง tasks → SQLite Queue → Workers → Results
//              ↑                                                    ↓
//              ←←←←←←←←←← อ่าน results ←←←←←←←←←←←←←←←←←←←←←←←←←←←

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dispatchTask, getTask } from './sqlite-task-queue.mjs';

const BRIDGE = process.env.AIPASS_BRIDGE ?? 'http://127.0.0.1:8787';
const PORT = process.env.BRAIN_PORT ?? 8789;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[brain]', ...a);

// ──────────────────────────────────────────────────────────────────── Call aipass

async function callAipass(messages, { model = 'claude-sonnet-5@default' } = {}) {
  const res = await fetch(`${BRIDGE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, messages }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`aipass returned ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ──────────────────────────────────────────────────────────────────── Read file for aipass

async function readFileForAipass(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');
    return { ok: true, path: filePath, content, size: content.length };
  } catch (err) {
    return { ok: false, path: filePath, error: err.message };
  }
}

// ──────────────────────────────────────────────────────────────────── Brain Process

async function processWithBrain(userRequest) {
  log('Processing request with aipass brain...');

  const systemPrompt = `You are a Brain Orchestrator AI. You plan and dispatch tasks to worker agents.

When you receive a request:
1. Analyze what needs to be done
2. If you need to read files, respond with: { "action": "read_file", "path": "..." }
3. If you need to create tasks, respond with: { "action": "dispatch", "tasks": [{ "type": "...", "payload": {...}, "model_hint": "..." }] }
4. If you need to respond directly, respond with: { "action": "respond", "content": "..." }

Available task types: read_file, write_file, list_dir, run_command, ai_task

Available worker models:
- meituan/longcat-2.0:free (coding, general)
- upstage/solar-pro-4 (multi-step, terminal, tool-calls)
- stepfun/step-3.7-flash (vision, visual-search)
- poolside/laguna-s-2.1 (fast-coding)
- poolside/laguna-xs-2.1 (lightweight)
- inclusionai/ling-3.0-flash-fin (finance)
- inclusionai/ling-3.0-flash-sante (medicine)

Always respond with valid JSON only.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userRequest },
  ];

  let maxIterations = 10;
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;
    log(`Brain iteration ${iteration}`);

    let aipassResponse;
    try {
      aipassResponse = await callAipass(messages);
    } catch (err) {
      log(`aipass call failed: ${err.message}`);
      return { error: err.message };
    }

    log(`aipass response: ${aipassResponse.slice(0, 200)}...`);

    let plan;
    try {
      const jsonMatch = aipassResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        plan = JSON.parse(jsonMatch[0]);
      } else {
        return { content: aipassResponse };
      }
    } catch {
      return { content: aipassResponse };
    }

    if (plan.action === 'respond') {
      return { content: plan.content };
    }

    if (plan.action === 'read_file') {
      const fileResult = await readFileForAipass(plan.path);
      messages.push(
        { role: 'assistant', content: aipassResponse },
        { role: 'user', content: `File result: ${JSON.stringify(fileResult)}` }
      );
      continue;
    }

    if (plan.action === 'dispatch') {
      const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
      if (tasks.length === 0) {
        return { content: 'No valid tasks in dispatch plan' };
      }
      const taskIds = [];
      for (const task of tasks) {
        const id = dispatchTask({
          type: task.type,
          payload: task.payload || {},
          modelHint: task.model_hint,
          dependencies: task.dependencies || [],
        });
        taskIds.push(id);
        log(`Dispatched task: ${id} (${task.type})`);
      }

      log(`Waiting for ${taskIds.length} tasks...`);
      const results = await waitForResults(taskIds, 60000);

      messages.push(
        { role: 'assistant', content: aipassResponse },
        { role: 'user', content: `Task results: ${JSON.stringify(results)}` }
      );
      continue;
    }

    return { content: aipassResponse };
  }

  return { error: 'Max iterations reached' };
}

async function waitForResults(taskIds, timeoutMs = 60000) {
  const results = {};
  const start = Date.now();

  while (Object.keys(results).length < taskIds.length && Date.now() - start < timeoutMs) {
    for (const id of taskIds) {
      if (results[id]) continue;
      const task = getTask(id);
      if (task && (task.status === 'completed' || task.status === 'failed')) {
        results[id] = task;
      }
    }

    if (Object.keys(results).length < taskIds.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  const pending = taskIds.filter(id => !results[id]);
  if (pending.length > 0) {
    log(`Timeout reached, pending tasks: ${pending.join(', ')}`);
  }

  return results;
}

// ──────────────────────────────────────────────────────────────────── HTTP Server

const server = http.createServer(async (req, res) => {
  const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (req.method === 'POST' && urlPath === '/process') {
    let body;
    try {
      body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
      body = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }

    const userRequest = body.request || '';
    if (!userRequest) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'request is required' }));
      return;
    }

    try {
      const result = await processWithBrain(userRequest);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && urlPath === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'brain-orchestrator' }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Brain Orchestrator on http://127.0.0.1:${PORT}`);
  log(`Bridge: ${BRIDGE}`);
  log('Ready to process requests...');
});
