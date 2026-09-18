#!/usr/bin/env node
// task-queue.mjs — Message queue ระหว่าง aipass ↔ longcat
// aipass เขียน tasks → longcat อ่านและทำงาน → เขียน results → aipass อ่าน

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const QUEUE_DIR = process.env.AIPASS_QUEUE_DIR ?? '/tmp/aipass-queue';
const TASKS_DIR = path.join(QUEUE_DIR, 'tasks');
const RESULTS_DIR = path.join(QUEUE_DIR, 'results');

// สร้าง directories ถ้ายังไม่มี
fs.mkdirSync(TASKS_DIR, { recursive: true });
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[queue]', ...a);

// ──────────────────────────────────────────────────────────────────── API

// aipass เขียน task → ส่งกลับ taskId
export function submitTask(type, payload) {
  const taskId = randomUUID().replace(/-/g, '').slice(0, 16);
  const task = {
    id: taskId,
    type, // 'read_file', 'write_file', 'run_command', 'list_dir'
    payload,
    status: 'pending',
    createdAt: Date.now(),
  };
  
  fs.writeFileSync(
    path.join(TASKS_DIR, `${taskId}.json`),
    JSON.stringify(task, null, 2)
  );
  
  log(`task submitted: ${taskId} (${type})`);
  return taskId;
}

// longcat รอรับ task ถัดไป
export function waitForTask(timeoutMs = 30000) {
  const start = Date.now();
  
  while (Date.now() - start < timeoutMs) {
    const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'));
    
    for (const file of files) {
      const taskPath = path.join(TASKS_DIR, file);
      const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
      
      if (task.status === 'pending') {
        // Mark as processing
        task.status = 'processing';
        task.startedAt = Date.now();
        fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
        
        return task;
      }
    }
    
    // Poll every 500ms
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  
  return null; // timeout
}

// longcat ส่งผลกลับ
export function completeTask(taskId, result, error = null) {
  const taskPath = path.join(TASKS_DIR, `${taskId}.json`);
  
  if (!fs.existsSync(taskPath)) {
    log(`task not found: ${taskId}`);
    return;
  }
  
  const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  task.status = error ? 'failed' : 'completed';
  task.completedAt = Date.now();
  task.result = result;
  task.error = error;
  
  // Move to results
  fs.writeFileSync(
    path.join(RESULTS_DIR, `${taskId}.json`),
    JSON.stringify(task, null, 2)
  );
  
  // Remove from tasks
  fs.unlinkSync(taskPath);
  
  log(`task completed: ${taskId} (${error ? 'FAILED' : 'OK'})`);
}

// aipass อ่านผลของ task
export function getResult(taskId, timeoutMs = 30000) {
  const start = Date.now();
  
  while (Date.now() - start < timeoutMs) {
    const resultPath = path.join(RESULTS_DIR, `${taskId}.json`);
    
    if (fs.existsSync(resultPath)) {
      const task = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      
      if (task.status === 'completed' || task.status === 'failed') {
        // Cleanup
        fs.unlinkSync(resultPath);
        return task;
      }
    }
    
    // Check if task still exists (might be pending or processing)
    const taskPath = path.join(TASKS_DIR, `${taskId}.json`);
    if (!fs.existsSync(taskPath) && !fs.existsSync(resultPath)) {
      return { status: 'unknown', error: 'task not found' };
    }
    
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  
  return { status: 'timeout', error: `task ${taskId} timed out after ${timeoutMs}ms` };
}

// aipass สร้าง task และรอผล ในคำสั่งเดียว
export function requestTask(type, payload, timeoutMs = 30000) {
  const taskId = submitTask(type, payload);
  return getResult(taskId, timeoutMs);
}

// ลบ tasks ที่เก่าเกิน 1 ชั่วโมง
export function cleanup() {
  const now = Date.now();
  const maxAge = 60 * 60 * 1000; // 1 hour
  
  for (const dir of [TASKS_DIR, RESULTS_DIR]) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAge) {
        fs.unlinkSync(filePath);
      }
    }
  }
  
  log('cleanup done');
}

// ──────────────────────────────────────────────────────────────────── CLI

const [,, command, ...args] = process.argv;

switch (command) {
  case 'submit': {
    const [type, ...payloadParts] = args;
    const payloadStr = payloadParts.join(' ');
    let payload;
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      payload = { raw: payloadStr };
    }
    const taskId = submitTask(type, payload);
    console.log(taskId);
    break;
  }
  
  case 'wait': {
    const timeout = parseInt(args[0], 10) || 30000;
    const task = waitForTask(timeout);
    if (task) {
      console.log(JSON.stringify(task));
    } else {
      console.log('TIMEOUT');
    }
    break;
  }
  
  case 'complete': {
    const [taskId, ...resultParts] = args;
    const resultStr = resultParts.join(' ');
    let result;
    try {
      result = JSON.parse(resultStr);
    } catch {
      result = { raw: resultStr };
    }
    completeTask(taskId, result);
    break;
  }
  
  case 'result': {
    const taskId = args[0];
    const timeout = parseInt(args[1], 10) || 30000;
    const result = getResult(taskId, timeout);
    console.log(JSON.stringify(result, null, 2));
    break;
  }
  
  case 'request': {
    const [type, ...payloadParts] = args;
    const payloadStr = payloadParts.join(' ');
    let payload;
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      payload = { raw: payloadStr };
    }
    const result = requestTask(type, payload);
    console.log(JSON.stringify(result, null, 2));
    break;
  }
  
  case 'cleanup':
    cleanup();
    break;
  
  default:
    console.log('Usage:');
    console.log('  task-queue.mjs submit <type> <json-payload>    # Submit task, returns taskId');
    console.log('  task-queue.mjs wait [timeout]                   # Wait for next task (worker)');
    console.log('  task-queue.mjs complete <taskId> <json-result>  # Complete task (worker)');
    console.log('  task-queue.mjs result <taskId> [timeout]        # Get result (orchestrator)');
    console.log('  task-queue.mjs request <type> <json-payload>    # Submit + wait for result');
    console.log('  task-queue.mjs cleanup                          # Remove old tasks');
    console.log('');
    console.log('Task types: read_file, write_file, list_dir, run_command');
}
