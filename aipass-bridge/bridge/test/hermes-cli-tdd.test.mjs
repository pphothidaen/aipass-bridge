// TDD: Hermes CLI E2E + Regression Tests for aipass/claude-sonnet-5@default
// Tests reference real CLI usage and prevent regression loops
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ORCHESTRATOR = process.env.ORCHESTRATOR ?? 'http://127.0.0.1:8788';

async function hermesChat(request, model = 'aipass/claude-sonnet-5@default') {
  const res = await fetch(`${ORCHESTRATOR}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, stream: false,
      messages: [{ role: 'user', content: request }],
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? JSON.stringify(data);
}

// ════════════════════════════════════════════════════════════════
// E2E: Hermes CLI reference usage
// ════════════════════════════════════════════════════════════════

test('E2E: hermes chat -q "Say hello in one word"', async () => {
  // CLI: hermes chat -q "Say hello in one word" --model aipass/claude-sonnet-5@default
  const result = await hermesChat('Say hello in one word');
  assert.ok(result.length > 0);
  assert.ok(result.length < 100, 'Should be a short greeting');
});

test('E2E: hermes chat -q "read /tmp/test.txt and tell me what it says"', async () => {
  // CLI: hermes chat -q "read /tmp/test.txt and tell me what it says"
  const fs = await import('node:fs/promises');
  await fs.writeFile('/tmp/hermes-e2e.txt', 'hermes-cli-e2e-test');
  const result = await hermesChat('read /tmp/hermes-e2e.txt and tell me what it says');
  assert.ok(result.includes('hermes-cli-e2e-test'), `Got: ${result}`);
});

test('E2E: hermes chat -q "read multiple files"', async () => {
  // CLI: hermes chat -q "read /tmp/a.txt and /tmp/b.txt"
  const fs = await import('node:fs/promises');
  await fs.writeFile('/tmp/hermes-multi-a.txt', 'content-a');
  await fs.writeFile('/tmp/hermes-multi-b.txt', 'content-b');
  const result = await hermesChat('read /tmp/hermes-multi-a.txt and /tmp/hermes-multi-b.txt');
  assert.ok(result.includes('content-a'));
  assert.ok(result.includes('content-b'));
});

test('E2E: hermes chat -q "list files in /tmp that start with test"', async () => {
  // CLI: hermes chat -q "list files in /tmp that start with test"
  const result = await hermesChat('list files in /tmp that start with hermes');
  assert.ok(result.length > 0);
  assert.ok(result.includes('hermes'), `Should list hermes files, got: ${result.slice(0, 200)}`);
});

test('E2E: hermes chat -q "what is 15 + 27?"', async () => {
  // CLI: hermes chat -q "what is 15 + 27?"
  const result = await hermesChat('what is 15 + 27?');
  assert.ok(result.includes('42'));
});

test('E2E: hermes chat -q "read non-existent file"', async () => {
  // CLI: hermes chat -q "read /tmp/this-file-does-not-exist-xyz.txt"
  const result = await hermesChat('read /tmp/this-file-does-not-exist-xyz.txt');
  // Should NOT crash — should return error message
  assert.ok(result.length > 0);
});

// ════════════════════════════════════════════════════════════════
// REGRESSION: Prevent Claude "I can't read files" loop
// ════════════════════════════════════════════════════════════════

test('REGRESSION: read file does NOT contain "I cannot" or "I can\'t"', async () => {
  // PREVENTS: Claude saying "I cannot access files" → loop
  const fs = await import('node:fs/promises');
  await fs.writeFile('/tmp/regression-loop-test.txt', 'loop-prevention');
  const result = await hermesChat('read /tmp/regression-loop-test.txt');
  assert.ok(!result.includes('I cannot'), `Regression! Claude refused: ${result}`);
  assert.ok(!result.includes("can't access"), `Regression! Claude refused: ${result}`);
  assert.ok(!result.includes('ไม่สามารถ'), `Regression! Claude refused in Thai: ${result}`);
});

test('REGRESSION: file read completes in < 5s (direct, not multi-round)', async () => {
  // PREVENTS: Multi-round loop (Claude → auto-read → Claude → auto-read → ...)
  const fs = await import('node:fs/promises');
  await fs.writeFile('/tmp/regression-speed-test.txt', 'speed-test');
  const start = Date.now();
  const result = await hermesChat('read /tmp/regression-speed-test.txt');
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `Took ${elapsed}ms — likely multi-round loop!`);
  assert.ok(result.includes('speed-test'));
});

test('REGRESSION: file read after normal chat (no stale state)', async () => {
  // PREVENTS: File read failing after conversation history
  await hermesChat('Hello, how are you?');
  const fs = await import('node:fs/promises');
  await fs.writeFile('/tmp/regression-state-test.txt', 'state-test');
  const result = await hermesChat('read /tmp/regression-state-test.txt');
  assert.ok(result.includes('state-test'));
});

test('REGRESSION: file read with Thai language request', async () => {
  // PREVENTS: Thai language breaking file detection
  const fs = await import('node:fs/promises');
  await fs.writeFile('/tmp/regression-thai.txt', 'thai-content');
  const result = await hermesChat('อ่านไฟล์ /tmp/regression-thai.txt');
  assert.ok(result.includes('thai-content'));
});

test('REGRESSION: health check stable after file operations', async () => {
  // PREVENTS: Health endpoint breaking after file operations
  for (let i = 0; i < 5; i++) {
    await hermesChat('read /tmp/test.txt');
  }
  const res = await fetch(`${ORCHESTRATOR}/health`);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.service, 'aipass-orchestrator');
});

// ════════════════════════════════════════════════════════════════
// HERMES CLI PIPELINE TESTS
// ════════════════════════════════════════════════════════════════

test('PIPELINE: /v1/models returns correct model IDs', async () => {
  const res = await fetch(`${ORCHESTRATOR}/v1/models`);
  const data = await res.json();
  assert.ok(data.data.some(m => m.id === 'claude-sonnet-5@default'));
});

test('PIPELINE: chat/completions returns valid OpenAI format', async () => {
  const res = await fetch(`${ORCHESTRATOR}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'aipass/claude-sonnet-5@default', stream: false,
      messages: [{ role: 'user', content: 'Hi' }],
    }),
  });
  const data = await res.json();
  assert.ok(data.id);
  assert.ok(data.object === 'chat.completion');
  assert.ok(data.choices?.[0]?.message?.content);
  assert.ok(data.choices?.[0]?.finish_reason === 'stop');
});
