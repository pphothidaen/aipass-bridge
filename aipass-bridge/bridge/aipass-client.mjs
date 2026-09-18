#!/usr/bin/env node
// aipass-client.mjs — Direct client สำหรับ aipass เรียกใช้ longcat worker โดยตรง
// ใช้ subprocess เรียก longcat-worker.mjs แล้วรอผลกลับมาเลย ไม่ต้องผ่าน queue

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'longcat-worker.mjs');

function runWorker(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [WORKER, ...args], {
      encoding: 'utf8',
      timeout: 30000
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    
    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Exit ${code}: ${stderr || stdout}`));
      } else {
        resolve(stdout.trim());
      }
    });
    
    proc.on('error', reject);
  });
}

// Read file from local filesystem
export async function readFile(filePath) {
  const payload = JSON.stringify({ path: filePath });
  const result = await runWorker(['read_file', payload]);
  return JSON.parse(result);
}

// Write file to local filesystem
export async function writeFile(filePath, content) {
  const payload = JSON.stringify({ filePath, content });
  const result = await runWorker(['write_file', payload]);
  return JSON.parse(result);
}

// List directory
export async function listDir(dirPath) {
  const payload = JSON.stringify({ path: dirPath || '.' });
  const result = await runWorker(['list_dir', payload]);
  return JSON.parse(result);
}

// Run shell command
export async function runCommand(command, cwd) {
  const payload = JSON.stringify({ command, cwd });
  const result = await runWorker(['run_command', payload]);
  return JSON.parse(result);
}

// Run Node.js script
export async function runNode(script) {
  const payload = JSON.stringify({ script });
  const result = await runWorker(['run_node', payload]);
  return JSON.parse(result);
}

// ──────────────────────────────────────────────────────────────────── CLI

const [,, command, ...args] = process.argv;

(async () => {
  try {
    let result;
    
    switch (command) {
      case 'read_file': {
        const filePath = args[0];
        if (!filePath) throw new Error('path is required');
        result = await readFile(filePath);
        break;
      }
      
      case 'write_file': {
        const filePath = args[0];
        const content = args.slice(1).join(' ');
        if (!filePath) throw new Error('filePath is required');
        result = await writeFile(filePath, content);
        break;
      }
      
      case 'list_dir': {
        const dirPath = args[0] || '.';
        result = await listDir(dirPath);
        break;
      }
      
      case 'run_command': {
        const cmd = args.join(' ');
        if (!cmd) throw new Error('command is required');
        result = await runCommand(cmd);
        break;
      }
      
      case 'run_node': {
        const script = args.join(' ');
        if (!script) throw new Error('script is required');
        result = await runNode(script);
        break;
      }
      
      default:
        console.log('Usage:');
        console.log('  aipass-client.mjs read_file <path>');
        console.log('  aipass-client.mjs write_file <path> <content>');
        console.log('  aipass-client.mjs list_dir [path]');
        console.log('  aipass-client.mjs run_command <command>');
        console.log('  aipass-client.mjs run_node <script>');
        process.exit(1);
    }
    
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
})();
