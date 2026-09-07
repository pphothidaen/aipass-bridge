// TDD Regression Tests for aipass-orchestrator
// Lock behavior: file operations must bypass Claude, return content directly
// If these tests fail, the inversion approach has regressed — fix immediately!
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ORCHESTRATOR = process.env.ORCHESTRATOR ?? 'http://127.0.0.1:8788';

async function chat(request) {
  const res = await fetch(`${ORCHESTRATOR}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5@default', stream: false,
      messages: [{ role: 'user', content: request }],
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// REGRESSION 1: read file must NOT contain "I can't read" or "I don't have"
test('REGRESSION: read file returns content, not "cannot access"', async () => {
  const fs = await import('node:fs/promises');
  await fs.writeFile('/tmp/reg-test.txt', 'regression-test-123');
  const result = await chat('read /tmp/reg-test.txt');
  assert.ok(result.includes('regression-test-123'), `Got: ${result.slice(0, 200)}`);
  assert.ok(!result.includes('I cannot'), `Claude refused: ${result.slice(0, 200)}`);
  assert.ok(!result.includes("don't have"), `Claude refused: ${result.slice(0, 200)}`);
});

// REGRESSION 2: read file must complete in < 5s (not calling Claude)
test('REGRESSION: read file completes in < 5s', async () => {
  const fs = await import('node:fs/promises');
  await fs.writeFile('/tmp/speed-test.txt', 'speed');
  const start = Date.now();
  const result = await chat('read /tmp/speed-test.txt');
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `Took ${elapsed}ms — too slow (should be direct file read)`);
  assert.ok(result.includes('speed'));
});

// REGRESSION 3: multiple files in one message
test('REGRESSION: read multiple files', async () => {
  const fs = await import('node:fs/promises');
  await fs.writeFile('/tmp/multi-1.txt', 'content-1');
  await fs.writeFile('/tmp/multi-2.txt', 'content-2');
  const result = await chat('read /tmp/multi-1.txt and /tmp/multi-2.txt');
  assert.ok(result.includes('content-1'));
  assert.ok(result.includes('content-2'));
});

// REGRESSION 4: basic chat still works (no regression on normal path)
test('REGRESSION: normal chat still works', async () => {
  const result = await chat('What is 2+2?');
  assert.ok(result.includes('4'));
});

// REGRESSION 5: file path without "read" prefix still detected
test('REGRESSION: bare file path detected', async () => {
  const fs = await import('node:fs/promises');
  await fs.writeFile('/tmp/bare-path.txt', 'bare-content');
  const result = await chat('show me /tmp/bare-path.txt');
  assert.ok(result.includes('bare-content'));
});

// REGRESSION 6: list directory returns file listing
test('REGRESSION: list directory works', async () => {
  const result = await chat('list files in /tmp that start with reg');
  assert.ok(result.length > 0);
});

// REGRESSION 7: orchestrator health endpoint returns correct service name
test('REGRESSION: health check returns correct service', async () => {
  const res = await fetch(`${ORCHESTRATOR}/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.service, 'aipass-orchestrator');
});
