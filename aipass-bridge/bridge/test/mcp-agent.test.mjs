// Tests for the MCP agent's read_file tool: verifies line numbers are
// correct for full reads, offset/limit pagination, and edge cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_AGENT = path.join(HERE, '..', 'mcp-agent.mjs');

// Spawn the MCP agent and communicate via JSON-RPC on stdio.
function startMcpAgent(root) {
  const child = spawn(process.execPath, [MCP_AGENT], {
    env: { ...process.env, AIPASS_AGENT_ROOT: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  const responses = [];
  const onLine = (line) => {
    if (!line.trim()) return;
    try { responses.push(JSON.parse(line)); } catch { /* ignore non-JSON */
    }
  };

  child.stdout.on('data', (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      onLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });

  return {
    child,
    responses,
    // Send a JSON-RPC request and wait for the matching response.
    call(method, params) {
      const id = Math.random().toString(36).slice(2);
      const req = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      child.stdin.write(req + '\n');
      return new Promise((resolve, reject) => {
        const check = setInterval(() => {
          const r = responses.find((x) => x.id === id);
          if (r) {
            clearInterval(check);
            if (r.error) reject(new Error(r.error.message));
            else resolve(r.result);
          }
        }, 10);
        setTimeout(() => {
          clearInterval(check);
          reject(new Error('timeout waiting for response'));
        }, 5000);
      });
    },
    stop() { child.kill('SIGKILL'); },
  };
}

test('read_file returns correct line numbers for a full file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  try {
    const content = 'first line\nsecond line\nthird line\n';
    fs.writeFileSync(path.join(dir, 'sample.txt'), content);

    const agent = startMcpAgent(dir);
    t.after(() => agent.stop());

    const result = await agent.call('tools/call', { name: 'read_file', arguments: { path: 'sample.txt' } });
    const text = result.content[0].text;

    assert.match(text, /1\|first line/, 'line 1 starts at 1, not 0');
    assert.match(text, /2\|second line/, 'line 2 is correct');
    assert.match(text, /3\|third line/, 'line 3 is correct');
    assert.doesNotMatch(text, /0\|/, 'no line 0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file respects offset and limit for pagination', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  try {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(path.join(dir, 'big.txt'), lines.join('\n') + '\n');

    const agent = startMcpAgent(dir);
    t.after(() => agent.stop());

    // Read lines 11-20
    const result = await agent.call('tools/call', {
      name: 'read_file',
      arguments: { path: 'big.txt', offset: 11, limit: 10 },
    });
    const text = result.content[0].text;

    assert.match(text, /11\|line 11/, 'offset starts at 11');
    assert.match(text, /20\|line 20/, 'last line is 20');
    assert.doesNotMatch(text, /10\|line 10/, 'does not include line before offset');
    assert.doesNotMatch(text, /21\|line 21/, 'does not include line after limit');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file handles offset beyond file length gracefully', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'short.txt'), 'only line\n');

    const agent = startMcpAgent(dir);
    t.after(() => agent.stop());

    const result = await agent.call('tools/call', {
      name: 'read_file',
      arguments: { path: 'short.txt', offset: 100, limit: 10 },
    });
    const text = result.content[0].text;

    assert.equal(text, '', 'returns empty string when offset is past end');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file handles a single-line file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'one.txt'), 'solo');

    const agent = startMcpAgent(dir);
    t.after(() => agent.stop());

    const result = await agent.call('tools/call', { name: 'read_file', arguments: { path: 'one.txt' } });
    const text = result.content[0].text;

    assert.match(text, /1\|solo/, 'single line is numbered 1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file preserves content with special characters', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  try {
    const content = '  indented line\nline with "quotes" and \'apostrophes\'\nline with \\backslash\n';
    fs.writeFileSync(path.join(dir, 'special.txt'), content);

    const agent = startMcpAgent(dir);
    t.after(() => agent.stop());

    const result = await agent.call('tools/call', { name: 'read_file', arguments: { path: 'special.txt' } });
    const text = result.content[0].text;

    assert.match(text, /1\|  indented line/, 'preserves leading spaces');
    assert.match(text, /2\|line with "quotes" and 'apostrophes'/, 'preserves quotes');
    assert.match(text, /3\|line with \\backslash/, 'preserves backslashes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file returns error for non-existent file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  try {
    const agent = startMcpAgent(dir);
    t.after(() => agent.stop());

    const result = await agent.call('tools/call', { name: 'read_file', arguments: { path: 'missing.txt' } });

    assert.equal(result.isError, true, 'isError flag is set');
    assert.match(result.content[0].text, /File not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file returns error for directory path', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'subdir'));

    const agent = startMcpAgent(dir);
    t.after(() => agent.stop());

    const result = await agent.call('tools/call', { name: 'read_file', arguments: { path: 'subdir' } });

    assert.equal(result.isError, true, 'isError flag is set');
    assert.match(result.content[0].text, /Not a file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file handles UTF-8 content (Thai)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  try {
    const content = 'สวัสดีครับ\nบรรทัดที่สอง\n';
    fs.writeFileSync(path.join(dir, 'thai.txt'), content);

    const agent = startMcpAgent(dir);
    t.after(() => agent.stop());

    const result = await agent.call('tools/call', { name: 'read_file', arguments: { path: 'thai.txt' } });
    const text = result.content[0].text;

    assert.match(text, /1\|สวัสดีครับ/, 'Thai content on line 1');
    assert.match(text, /2\|บรรทัดที่สอง/, 'Thai content on line 2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
