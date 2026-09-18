#!/usr/bin/env node
// sqlite-queue.mjs — SQLite task queue for brain-worker system
// ESM module — uses Node.js built-in node:sqlite

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB = process.env.QUEUE_DB || `${__dirname}/queue.db`;

mkdirSync(dirname(DB), { recursive: true });
const db = new DatabaseSync(DB);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT DEFAULT '{}',
    model TEXT,
    status TEXT DEFAULT 'pending',
    result TEXT,
    error TEXT,
    retries INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    created_at INTEGER,
    started_at INTEGER,
    completed_at INTEGER
  )
`);

export function task({ type, payload = {}, model = null }) {
  const id = randomUUID().slice(0, 12);
  db.prepare('INSERT INTO tasks (id, type, payload, model, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, type, JSON.stringify(payload), model, Date.now());
  return id;
}

export function poll(model) {
  const t = db.prepare('SELECT * FROM tasks WHERE status=? AND model=? ORDER BY created_at LIMIT 1').get('pending', model);
  if (t) {
    db.prepare('UPDATE tasks SET status=?, started_at=? WHERE id=?').run('running', Date.now(), t.id);
    return { ...t, payload: JSON.parse(t.payload) };
  }
  return null;
}

export function complete(id, result) {
  db.prepare('UPDATE tasks SET status=?, result=?, completed_at=? WHERE id=?')
    .run('completed', JSON.stringify(result), Date.now(), id);
}

export function fail(id, err) {
  db.prepare('UPDATE tasks SET status=?, error=?, completed_at=? WHERE id=?')
    .run('failed', err.message || String(err), Date.now(), id);
}

export function result(id) {
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND status IN (?, ?)').get(id, 'completed', 'failed');
  return t ? { ...t, result: t.result ? JSON.parse(t.result) : null } : null;
}

export function waitFor(id, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const r = result(id);
    if (r) return r;
    const then = Date.now();
    while (Date.now() - then < 500) {
      // Busy wait for 500ms
    }
  }
  return { status: 'timeout' };
}
