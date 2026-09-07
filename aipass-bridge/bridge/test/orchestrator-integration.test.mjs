// Phase 2: Integration Tests for aipass-orchestrator
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ORCHESTRATOR = process.env.ORCHESTRATOR ?? 'http://127.0.0.1:8788';

async function callOrchestrator(request) {
  const res = await fetch(`${ORCHESTRATOR}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5@default', stream: false,
      messages: [{ role: 'user', content: request }],
    }),
  });
  if (!res.ok) throw new Error(`Orchestrator returned ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? JSON.stringify(data);
}

test('Phase 2.1: health check', async () => {
  const res = await fetch(`${ORCHESTRATOR}/health`);
  assert.equal(res.status, 200);
});

test('Phase 2.1: models endpoint', async () => {
  const res = await fetch(`${ORCHESTRATOR}/v1/models`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.data.length >= 1);
});

test('Phase 2.1: basic chat', async () => {
  const result = await callOrchestrator('Say hello');
  assert.ok(result.length > 0);
});

test('Phase 2.2: read file', async () => {
  const fs = await import('node:fs/promises');
  await fs.writeFile('/tmp/test-int.txt', 'integration-test-content');
  const result = await callOrchestrator('read /tmp/test-int.txt');
  assert.ok(result.includes('integration-test-content'));
});

test('Phase 2.3: math reasoning', async () => {
  const result = await callOrchestrator('what is 15 + 27?');
  assert.ok(result.includes('42'));
});

test('Phase 2.4: malformed request', async () => {
  const res = await fetch(`${ORCHESTRATOR}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'invalid',
  });
  assert.equal(res.status, 400);
});

test('Phase 2.4: empty messages', async () => {
  const res = await fetch(`${ORCHESTRATOR}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(res.status, 400);
});
