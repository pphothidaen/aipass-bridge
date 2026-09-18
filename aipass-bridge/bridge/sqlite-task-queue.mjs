#!/usr/bin/env node
// sqlite-task-queue.mjs — SQLite-based DAG task queue ตาม aipass design
// ใช้ Node.js built-in node:sqlite (ไม่ต้อง install package)

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.AIPASS_DB_PATH ?? '/tmp/aipass-queue/tasks.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

// ──────────────────────────────────────────────────────────────────── Schema (ตาม aipass design)

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    model_hint TEXT,
    status TEXT DEFAULT 'pending',
    dependencies TEXT DEFAULT '[]',
    retry_count INTEGER DEFAULT 0,
    retry_max INTEGER DEFAULT 3,
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_model ON tasks(model_hint);
`);

// ──────────────────────────────────────────────────────────────────── Model Router

const WORKER_MODELS = {
  'meituan/longcat-2.0:free': { context: 131072, skills: ['coding', 'general', 'long-context'] },
  'upstage/solar-pro-4': { context: 524000, skills: ['multi-step', 'terminal', 'tool-calls'] },
  'stepfun/step-3.7-flash': { context: 131072, skills: ['vision', 'visual-search'] },
  'poolside/laguna-s-2.1': { context: 131072, skills: ['fast-coding'] },
  'poolside/laguna-xs-2.1': { context: 65536, skills: ['fast-coding', 'lightweight'] },
  'inclusionai/ling-3.0-flash-fin': { context: 131072, skills: ['finance', 'investment'] },
  'inclusionai/ling-3.0-flash-sante': { context: 131072, skills: ['medicine', 'clinical'] },
};

function selectModel(type, payload) {
  const s = `${type} ${JSON.stringify(payload)}`.toLowerCase();
  if (/vision|image|visual|photo|screenshot/i.test(s)) return 'stepfun/step-3.7-flash';
  if (/finance|invest|stock|portfolio|trading/i.test(s)) return 'inclusionai/ling-3.0-flash-fin';
  if (/medical|health|diagnosis|symptom|clinical/i.test(s)) return 'inclusionai/ling-3.0-flash-sante';
  if (/terminal|command|shell|exec|npm|build|deploy/i.test(s)) return 'upstage/solar-pro-4';
  if (/multi.*step|complex|analyze|research|architecture/i.test(s)) return 'upstage/solar-pro-4';
  if (/quick.*fix|small.*change|lint|format|rename/i.test(s)) return 'poolside/laguna-s-2.1';
  if (/code|program|function|class|api|refactor|debug|bug|file/i.test(s)) return 'meituan/longcat-2.0:free';
  return 'meituan/longcat-2.0:free';
}

// ──────────────────────────────────────────────────────────────────── Brain Operations

export function dispatchTask({ type, payload = {}, modelHint = null, dependencies = [], retryMax = 3 }) {
  const id = randomUUID().replace(/-/g, '').slice(0, 16);
  const model = modelHint || selectModel(type, payload);
  const now = Date.now();
  
  db.prepare(`
    INSERT INTO tasks (id, type, payload, model_hint, dependencies, retry_max, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, type, JSON.stringify(payload), model, JSON.stringify(dependencies), retryMax, now);
  
  return id;
}

export function getCompletedTasks() {
  const rows = db.prepare(`
    SELECT id, type, payload, model_hint, result, error, completed_at
    FROM tasks WHERE status = 'completed'
    ORDER BY completed_at ASC
  `).all();
  
  return rows.map(r => ({
    id: r.id,
    type: r.type,
    payload: JSON.parse(r.payload),
    model: r.model_hint,
    result: r.result ? JSON.parse(r.result) : null,
    completedAt: r.completed_at,
  }));
}

export function getTask(taskId) {
  const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    payload: JSON.parse(row.payload),
    model: row.model_hint,
    status: row.status,
    dependencies: JSON.parse(row.dependencies),
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error,
  };
}

// ──────────────────────────────────────────────────────────────────── Worker Operations

export function pollTask(modelName) {
  // Find tasks that are pending, match model, and have all dependencies completed
  const task = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending'
    AND (model_hint = ? OR model_hint IS NULL)
    AND (
      dependencies = '[]'
      OR dependencies IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM json_each(tasks.dependencies) AS dep
        WHERE dep.value NOT IN (SELECT id FROM tasks WHERE status = 'completed')
      )
    )
    ORDER BY created_at ASC
    LIMIT 1
  `).get(modelName);
  
  if (!task) return null;
  
  // Mark as running
  db.prepare(`UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?`).run(Date.now(), task.id);
  
  return {
    id: task.id,
    type: task.type,
    payload: JSON.parse(task.payload),
    model: task.model_hint,
    dependencies: JSON.parse(task.dependencies),
    retryCount: task.retry_count,
    retryMax: task.retry_max,
  };
}

export function completeTask(taskId, result) {
  db.prepare(`
    UPDATE tasks SET status = 'completed', result = ?, completed_at = ?
    WHERE id = ?
  `).run(JSON.stringify(result), Date.now(), taskId);
}

export function failTask(taskId, error) {
  const task = db.prepare(`SELECT retry_count, retry_max FROM tasks WHERE id = ?`).get(taskId);
  
  if (task && task.retry_count < task.retry_max) {
    db.prepare(`
      UPDATE tasks SET status = 'pending', retry_count = retry_count + 1, error = ?
      WHERE id = ?
    `).run(error, taskId);
  } else {
    db.prepare(`
      UPDATE tasks SET status = 'failed', error = ?, completed_at = ?
      WHERE id = ?
    `).run(error, Date.now(), taskId);
  }
}

// ──────────────────────────────────────────────────────────────────── CLI

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'dispatch': {
    const [type, payloadStr] = args;
    const id = dispatchTask({ type, payload: payloadStr ? JSON.parse(payloadStr) : {} });
    console.log(id);
    break;
  }
  case 'poll': {
    const model = args[0];
    const task = pollTask(model);
    console.log(JSON.stringify(task, null, 2));
    break;
  }
  case 'complete': {
    const [taskId, resultStr] = args;
    completeTask(taskId, resultStr ? JSON.parse(resultStr) : {});
    break;
  }
  case 'fail': {
    const [taskId, error] = args;
    failTask(taskId, error || 'unknown');
    break;
  }
  case 'get': {
    const taskId = args[0];
    console.log(JSON.stringify(getTask(taskId), null, 2));
    break;
  }
  case 'completed': {
    console.log(JSON.stringify(getCompletedTasks(), null, 2));
    break;
  }
  case 'router': {
    const type = args[0];
    const payload = args[1] ? JSON.parse(args[1]) : {};
    const model = selectModel(type, payload);
    console.log(JSON.stringify({ model, info: WORKER_MODELS[model] }, null, 2));
    break;
  }
  default:
    console.log('Usage:');
    console.log('  sqlite-task-queue.mjs dispatch <type> <json-payload>');
    console.log('  sqlite-task-queue.mjs poll <model-name>');
    console.log('  sqlite-task-queue.mjs complete <taskId> <json-result>');
    console.log('  sqlite-task-queue.mjs fail <taskId> <error>');
    console.log('  sqlite-task-queue.mjs get <taskId>');
    console.log('  sqlite-task-queue.mjs completed');
    console.log('  sqlite-task-queue.mjs router <type> [json-payload]');
}
