// Phase 3: Hermes E2E Tests
// Tests the full pipeline as Hermes would call it
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ORCHESTRATOR = process.env.ORCHESTRATOR ?? 'http://127.0.0.1:8788';

async function hermesChat(request, model = 'claude-sonnet-5@default') {
  const res = await fetch(`${ORCHESTRATOR}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, stream: false,
      messages: [{ role: 'user', content: request }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ── Phase 3.1: Hermes Provider Pipeline ───────────────────────────────

test('Phase 3.1: model discovery', async () => {
  const res = await fetch(`${ORCHESTRATOR}/v1/models`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.data.length >= 1);
  assert.ok(data.data.some(m => m.id === 'claude-sonnet-5@default'));
});

test('Phase 3.1: basic chat (non-stream)', async () => {
  const result = await hermesChat('Say hello in 2 words');
  assert.ok(result.length > 0);
  assert.ok(typeof result === 'string');
});

test('Phase 3.1: chat with history', async () => {
  const res = await fetch(`${ORCHESTRATOR}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5@default', stream: false,
      messages: [
        { role: 'user', content: 'My name is Kim' },
        { role: 'assistant', content: 'Hello Kim!' },
        { role: 'user', content: 'What is my name?' },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? '';
  assert.ok(content.length > 0);
});

// ── Phase 3.2: File Operations (Inversion) ────────────────────────────

test('Phase 3.2: Hermes asks to read file', async () => {
  const fs = await import('node:fs/promises');
  await fs.writeFile('/tmp/hermes-test.txt', 'Hermes E2E test content');
  const result = await hermesChat('read /tmp/hermes-test.txt');
  assert.ok(result.includes('Hermes E2E test content'));
});

test('Phase 3.2: read source code file', async () => {
  const result = await hermesChat('read /tmp/test.txt');
  assert.ok(result.includes('hello world'));
});

test('Phase 3.2: non-existent file handled', async () => {
  const result = await hermesChat('read /tmp/does-not-exist-xyz.txt');
  assert.ok(result.length > 0);  // Should not crash
});

// ── Phase 3.3: Error Handling ─────────────────────────────────────────

test('Phase 3.3: bad JSON returns 400', async () => {
  const res = await fetch(`${ORCHESTRATOR}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  });
  assert.equal(res.status, 400);
});

test('Phase 3.3: missing messages returns 400', async () => {
  const res = await fetch(`${ORCHESTRATOR}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('Phase 3.3: 404 for unknown routes', async () => {
  const res = await fetch(`${ORCHESTRATOR}/unknown-route`);
  assert.equal(res.status, 404);
});
