#!/usr/bin/env node
// longcat-worker.mjs — Worker ที่รอรับ tasks จาก aipass และ execute ผ่าน Hermes tools
// วิธีใช้: node bridge/longcat-worker.mjs --poll

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const QUEUE_DIR = process.env.AIPASS_QUEUE_DIR ?? '/tmp/aipass-queue';
const TASKS_DIR = path.join(QUEUE_DIR, 'tasks');
const RESULTS_DIR = path.join(QUEUE_DIR, 'results');

fs.mkdirSync(TASKS_DIR, { recursive: true });
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[worker]', ...a);

// Execute task using Node.js built-in tools
async function executeTask(task) {
  const { type, payload } = task;
  
  switch (type) {
    case 'read_file': {
      const filePath = payload.path;
      if (!filePath) throw new Error('path is required');
      
      const content = fs.readFileSync(filePath, 'utf8');
      return { path: filePath, content, size: content.length };
    }
    
    case 'write_file': {
      const { filePath, content } = payload;
      if (!filePath) throw new Error('filePath is required');
      
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      return { path: filePath, written: content.length };
    }
    
    case 'list_dir': {
      const dirPath = payload.path || '.';
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return {
        path: dirPath,
        entries: entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file'
        }))
      };
    }
    
    case 'run_command': {
      const { command, cwd } = payload;
      if (!command) throw new Error('command is required');
      
      return new Promise((resolve, reject) => {
        const proc = spawn('sh', ['-c', command], {
          cwd: cwd || process.cwd(),
          encoding: 'utf8',
          timeout: 30000
        });
        
        let stdout = '';
        let stderr = '';
        
        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);
        
        proc.on('close', code => {
          resolve({ command, exitCode: code, stdout: stdout.trim(), stderr: stderr.trim() });
        });
        
        proc.on('error', reject);
      });
    }
    
    case 'run_node': {
      const { script } = payload;
      if (!script) throw new Error('script is required');
      
      return new Promise((resolve, reject) => {
        const proc = spawn('node', ['-e', script], {
          encoding: 'utf8',
          timeout: 30000
        });
        
        let stdout = '';
        let stderr = '';
        
        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);
        
        proc.on('close', code => {
          resolve({ exitCode: code, stdout: stdout.trim(), stderr: stderr.trim() });
        });
        
        proc.on('error', reject);
      });
    }
    
    default:
      throw new Error(`Unknown task type: ${type}`);
  }
}

// Poll for tasks
async function poll() {
  log('waiting for tasks...');
  
  while (true) {
    const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'));
    
    for (const file of files) {
      const taskPath = path.join(TASKS_DIR, file);
      
      try {
        const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
        
        if (task.status !== 'pending') continue;
        
        // Mark as processing
        task.status = 'processing';
        task.startedAt = Date.now();
        fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
        
        log(`processing task: ${task.id} (${task.type})`);
        
        try {
          const result = await executeTask(task);
          
          // Write result
          task.status = 'completed';
          task.completedAt = Date.now();
          task.result = result;
          
          fs.writeFileSync(
            path.join(RESULTS_DIR, `${task.id}.json`),
            JSON.stringify(task, null, 2)
          );
          
          log(`task completed: ${task.id}`);
        } catch (err) {
          // Write error
          task.status = 'failed';
          task.completedAt = Date.now();
          task.error = err.message;
          
          fs.writeFileSync(
            path.join(RESULTS_DIR, `${task.id}.json`),
            JSON.stringify(task, null, 2)
          );
          
          log(`task failed: ${task.id} - ${err.message}`);
        }
        
        // Remove from tasks
        fs.unlinkSync(taskPath);
      } catch (err) {
        log(`error processing ${file}: ${err.message}`);
      }
    }
    
    // Poll every 1 second
    await new Promise(r => setTimeout(r, 1000));
  }
}

// One-shot mode: execute single task from CLI args
async function executeOnce(type, payload) {
  const task = {
    id: 'once',
    type,
    payload,
    status: 'processing',
    startedAt: Date.now()
  };
  
  try {
    const result = await executeTask(task);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// ──────────────────────────────────────────────────────────────────── CLI

const [,, mode, ...args] = process.argv;

if (mode === '--poll') {
  // Continuous polling mode (background worker)
  poll().catch(err => {
    log(`fatal error: ${err.message}`);
    process.exit(1);
  });
} else if (mode === 'read_file' || mode === 'write_file' || mode === 'list_dir' || mode === 'run_command' || mode === 'run_node') {
  // One-shot execution
  const type = mode;
  const payloadStr = args.join(' ');
  let payload;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    payload = { raw: payloadStr };
  }
  executeOnce(type, payload);
} else if (mode === '--help' || mode === '-h') {
  console.log('Usage:');
  console.log('  longcat-worker.mjs --poll                    # Start continuous worker');
  console.log('  longcat-worker.mjs read_file \'{"path":"..."}\'  # Read a file');
  console.log('  longcat-worker.mjs write_file \'{"filePath":"...","content":"..."}\'  # Write a file');
  console.log('  longcat-worker.mjs list_dir \'{"path":"..."}\'   # List directory');
  console.log('  longcat-worker.mjs run_command \'{"command":"..."}\'  # Run shell command');
  console.log('  longcat-worker.mjs run_node \'{"script":"..."}\'    # Run Node.js script');
} else {
  console.log('Unknown mode. Use --help for usage.');
  process.exit(1);
}
