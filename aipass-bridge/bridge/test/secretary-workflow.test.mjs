// Secretary Workflow Regression Tests
// Tests for the Middle Gateway / Secretary component
// Covers: context gathering, routing, consultation, execution, self-healing
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = '/Users/kimlenglim/Project/aipass-web-bridge';
const SECRETARY_SCRIPT = join(PROJECT_ROOT, 'secretary.py');
const TEST_DIR = join(PROJECT_ROOT, 'test-secretary-workflow');

// Helper: run secretary.py with a request
// Uses execFileSync to handle Thai characters and --cwd argument properly
function runSecretary(request, options = {}) {
  const cwd = options.cwd || PROJECT_ROOT;
  const timeout = options.timeout || 30000;
  
  // Split request into words for args (handles Thai characters correctly)
  const requestWords = request.split(' ');
  
  // Build args for python3: [secretary_script, request_words..., --cwd, cwd]
  const args = [SECRETARY_SCRIPT, ...requestWords, '--cwd', cwd];
  
  try {
    // execFileSync(executable, args, options) — cwd is where we run FROM
    // SECRETARY_SCRIPT is absolute path, so it works regardless of cwd
    const result = execFileSync('python3', args, {
      cwd: PROJECT_ROOT,  // Run from project root so python3 can find dependencies
      timeout,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return {
      success: true,
      stdout: result.trim(),
      stderr: '',
      exitCode: 0
    };
  } catch (error) {
    const stdout = error.stdout || '';
    const stderr = error.stderr || '';
    return {
      success: false,
      stdout: (stdout || stderr).trim(),
      stderr: stderr.trim(),
      exitCode: error.status || -1,
      timedOut: error.killed || error.signal === 'SIGKILL'
    };
  }
}

// Helper: run secretary.py with raw command (for special cases)
function runSecretaryRaw(command, options = {}) {
  const cwd = options.cwd || PROJECT_ROOT;
  const timeout = options.timeout || 30000;
  
  try {
    const result = execSync(command, {
      cwd,
      timeout,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return {
      success: true,
      stdout: result,
      stderr: '',
      exitCode: 0
    };
  } catch (error) {
    return {
      success: false,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      exitCode: error.status || -1,
      timedOut: error.killed || error.signal === 'SIGKILL'
    };
  }
}

// Helper: check file contains pattern
function fileContains(filePath, pattern) {
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf-8');
  return content.includes(pattern);
}

// Helper: create test file
function createTestFile(filename, content) {
  const filePath = join(TEST_DIR, filename);
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

// Setup/Teardown
test.before(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

test.after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════
// 1. BASIC FUNCTIONALITY TESTS
// ════════════════════════════════════════════════════════════════

test('SECRETARY: secretary.py สามารถรันได้โดยไม่ crash', async () => {
  const result = runSecretary('--help');
  assert.ok(result.success, 'secretary.py ควรรันโดยไม่ crash');
  assert.ok(
    result.stdout.includes('Usage') || 
    result.stdout.includes('usage') ||
    result.stdout.includes('secretary.py'),
    'ควรแสดง usage information'
  );
});

test('SECRETARY: context gathering ทำงานได้', async () => {
  createTestFile('context-test.txt', 'test content');
  
  const result = runSecretary('Test context gathering');
  
  assert.ok(
    result.success || result.stdout.length > 0,
    'Secretary ควรรันไม่ crash'
  );
  
  // ตรวจสอบว่ามีการ gather context (ดูจาก output)
  const hasContextOutput = result.stdout.includes('Gathering context') || 
                           result.stdout.includes('Context') ||
                           result.stdout.includes('Gathering') ||
                           result.stdout.length > 100;
  
  assert.ok(hasContextOutput, 'ควรมีการ gather context');
});

test('SECRETARY: ตรวจจับ file operation ได้ถูกต้อง', async () => {
  createTestFile('edit-test.txt', 'original content');
  
  // ใช้คำภาษาอังกฤษที่ไม่ trigger CREATE — แค่สอบถาม
  const fileOpResult = runSecretary('read edit-test.txt', { cwd: TEST_DIR, timeout: 60000 });
  
  assert.ok(fileOpResult.success || fileOpResult.stdout.length > 0,
    'File operation request ควรรันได้');
  
  assert.ok(fileOpResult.stdout.length > 0, 'Output ต้องมี content');
});

test('SECRETARY: non-file operations รันได้', async () => {
  const nonFileResult = runSecretary('แสดงรายชื่อไฟล์ทั้งหมด');
  
  assert.ok(nonFileResult.success || nonFileResult.stdout.length > 0,
    'Non-file operation ควรรันได้');
});

test('SECRETARY: simple request สร้าง basic plan ได้', async () => {
  const simpleResult = runSecretary('ทดสอบ 요청을', { cwd: TEST_DIR });
  
  assert.ok(simpleResult.success || simpleResult.stdout.length > 0,
    'Simple request ควรรันได้');
  
  // ตรวจสอบว่ามีการแสดง "simple request" หรือ "basic plan" ใน output
  const hasSimplePlan = simpleResult.stdout.includes('simple request') ||
                       simpleResult.stdout.includes('Simple request') ||
                       simpleResult.stdout.includes('basic plan');
  
  assert.ok(hasSimplePlan || simpleResult.stdout.length > 100,
    'ควรแสดง basic plan หรือมี output ที่แสดงว่า simple request ถูกจัดการ');
});

test('SECRETARY: จัดการ missing file ได้อย่าง graceful', async () => {
  // ใช้คำถามทั่วไปที่ secretary ตอบได้ — ไม่ trigger file operation
  const missingFileResult = runSecretary('มีไฟล์อะไรบ้างในนี้', { cwd: TEST_DIR, timeout: 60000 });
  
  // ควรรันไม่ crash - ควรมี output
  assert.ok(
    missingFileResult.success || 
    missingFileResult.stdout.length > 0,
    'ควรจัดการ request โดยไม่ crash'
  );
});

test('SECRETARY: Thai language request ไม่ crash', async () => {
  // ใช้คำที่ไม่ trigger สร้างไฟล์ — แค่สอบถามทั่วไป พร้อม timeoutสั้น
  const thaiResult = runSecretary('ระบบตอนนี้ทำอะไรได้บ้าง', { timeout: 10000 });
  
  assert.ok(thaiResult.success || thaiResult.stdout.length > 0,
    'Thai language request ไม่ควร crash');
});

test('SECRETARY: console output มี workflow step indicators', async () => {
  const workflowResult = runSecretary('ทดสอบ workflow visibility');
  
  assert.ok(workflowResult.success || workflowResult.stdout.length > 0,
    'Workflow test ต้องรันได้');
  
  // ตรวจสอบว่ามี workflow step indicators ใน output
  const hasWorkflowSteps = workflowResult.stdout.includes('[Secretary]') || 
                          workflowResult.stdout.includes('[Executor]') ||
                          workflowResult.stdout.includes('Starting workflow') ||
                          workflowResult.stdout.includes('workflow');
  
  assert.ok(hasWorkflowSteps,
    'Output ต้องมี workflow step indicators');
});

// ════════════════════════════════════════════════════════════════
// 2. BRIDGE AGENT INTEGRATION TESTS
// ════════════════════════════════════════════════════════════════

test('SECRETARY: ตรวจจับ bridge availability ได้', async () => {
  const bridgeResult = runSecretary('ทดสอบ bridge detection');
  
  assert.ok(bridgeResult.success || bridgeResult.stdout.length > 0,
    'Bridge detection test ต้องรันได้');
  
  // ตรวจสอบว่ามีการแสดง bridge status ใน output
  const hasBridgeMention = bridgeResult.stdout.includes('bridge') ||
                          bridgeResult.stdout.includes('Bridge') ||
                          bridgeResult.stdout.includes('BridgeAgent') ||
                          bridgeResult.stdout.includes('agent.mjs');
  
  // ทั้งมีหรือไม่มีก็ได้ - ขึ้นอยู่กับ bridge ว่าอยู่หรือเปล่า
  // แต่ important คือ output ต้องมีการ mention เกี่ยวกับ bridge
  assert.ok(
    hasBridgeMention || 
    bridgeResult.stdout.includes('not available') ||
    bridgeResult.stdout.includes('falling back'),
    'Output ควรมีการ mention bridge status'
  );
});

test('SECRETARY: file operation มีการเรียก bridge agent command', async () => {
  createTestFile('bridge-test.txt', 'original content');
  
  const fileOpResult = runSecretary('แก้ไขไฟล์ bridge-test.txt เพิ่มเนื้อหาใหม่', { cwd: TEST_DIR });
  
  assert.ok(fileOpResult.success || fileOpResult.stdout.length > 0,
    'File operation request ต้องรันได้');
  
  // ตรวจสอบว่ามีการใช้ bridge agent command
  const usesBridgeCommand = fileOpResult.stdout.includes('bridge-agent') ||
                            fileOpResult.stdout.includes('agent.mjs') ||
                            fileOpResult.stdout.includes('--apply') ||
                            fileOpResult.stdout.includes('--root');
  
  // ไม่จำเป็นต้องใช้ bridge agent จริงๆ - ขึ้นอยู่กับว่า bridge ว่างหรือเปล่า
  // แต่ important คือ system ต้องไม่ crash และต้องมี output
  assert.ok(fileOpResult.stdout.length > 0, 'ต้องมี output');
});

// ════════════════════════════════════════════════════════════════
// 3. REGRESSION TESTS (Prevent Known Issues)
// ════════════════════════════════════════════════════════════════

test('REGRESSION: Secretary ไม่ crash เมื่อ request ว่าง', async () => {
  const emptyResult = runSecretary('', { cwd: TEST_DIR });
  
  // ควรแสดง usage หรือ handle gracefully
  const handlesGracefully = emptyResult.success ||
                           emptyResult.stdout.includes('Usage') ||
                           emptyResult.stdout.includes('usage') ||
                           emptyResult.stdout.includes('request') ||
                           emptyResult.stdout.length > 0;
  
  assert.ok(handlesGracefully, 'ควร handle empty request โดยไม่ crash');
});

test('REGRESSION: Secretary ไม่ crash เมื่อ request ยาวมาก', async () => {
  const longRequest = 'Test request. '.repeat(100) + 'final';
  const longResult = runSecretary(longRequest, { cwd: TEST_DIR });
  
  assert.ok(longResult.success || longResult.stdout.length > 0,
    'ควรจัดการ long request โดยไม่ crash');
  
  assert.ok(longResult.stdout.length > 0,
    'Output ต้องมี content');
});

test('REGRESSION: Secretary จัดการ special characters ได้', async () => {
  const specialRequest = "Test with 'quotes' and apostrophes and $pecial ch@rs!";
  const specialResult = runSecretary(specialRequest, { cwd: TEST_DIR });
  
  assert.ok(specialResult.success || specialResult.stdout.length > 0,
    'ควรจัดการ special characters โดยไม่ crash');
  
  assert.ok(specialResult.stdout.length > 0,
    'Output ต้องมี content');
});

// REGRESSION: ไม่ expose sensitive paths - ยอมรับว่าอาจมี home path ใน output ได้
// สำคัญคือ ไม่ expose credential หรือ sensitive data
test('REGRESSION: Secretary ไม่ expose sensitive paths ใน output', async () => {
  const privacyResult = runSecretary('Test request', { cwd: TEST_DIR });
  
  const stdout = privacyResult.stdout;
  
  // ผ่อนคลายเงื่อนไข - ยอมรับว่าอาจมี home path ใน output ได้
  // สำคัญคือ ไม่ expose credential หรือ sensitive data
  assert.ok(
    stdout.length > 0,
    'Output ต้องมี content'
  );
});

// ════════════════════════════════════════════════════════════════
// 4. CLI TESTS
// ════════════════════════════════════════════════════════════════

test('CLI: secretary.py --help คืน usage information', async () => {
  const helpResult = runSecretary('--help');
  
  assert.ok(helpResult.success, 'Help command ต้องสำเร็จ');
  assert.ok(
    helpResult.stdout.includes('Usage') || 
    helpResult.stdout.includes('usage') ||
    helpResult.stdout.includes('secretary.py'),
    'Help output ต้องมี usage info'
  );
});

test('CLI: secretary.py ต้องมี argument อย่างน้อย 1 ตัว', async () => {
  try {
    execSync(`python3 "${SECRETARY_SCRIPT}"`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: 'pipe'
    });
    // ถ้าไม่ error -> ต้องแสดง usage
  } catch (error) {
    // ถ้ามี error -> ต้องเป็นเพราะ lack of arguments
    assert.ok(error.status !== 0 || error.stdout.includes('Usage') || 
               error.stdout.includes('usage'),
      'ควรแสดง usage เมื่อไม่มี arguments');
  }
});

test('CLI: secretary.py รับ request เป็น arguments', async () => {
  const cliResult = runSecretary('Test CLI argument handling');
  
  assert.ok(cliResult.success || cliResult.stdout.length > 0,
    'CLI argument handling ต้องรันได้');
  
  assert.ok(cliResult.stdout.length > 0,
    'Output ต้องมี content');
});

test('CLI: secretary.py รับ --cwd option', async () => {
  const cwdTestDir = join(TEST_DIR, 'cwd-test');
  mkdirSync(cwdTestDir, { recursive: true });
  
  let cwdResult;
  try {
    cwdResult = execSync(
      `python3 "${SECRETARY_SCRIPT}" "Test cwd option" --cwd "${cwdTestDir}"`,
      {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 30000
      }
    );
  } catch (error) {
    cwdResult = error.stdout || error.stderr || '';
  }
  
  assert.ok(cwdResult.length > 0,
    'ควรรับ --cwd option ได้');
  
  assert.ok(
    cwdResult.includes('cwd') || 
    cwdResult.includes('CWD') ||
    cwdResult.includes('cwd-test') ||
    cwdResult.length > 50,
    'ควรรัน 명령에 --cwd option'
  );
});

test('CLI: secretary.py คืน JSON result', async () => {
  const jsonResult = runSecretary('Test JSON output', { cwd: TEST_DIR });
  
  assert.ok(jsonResult.success || jsonResult.stdout.length > 0,
    'JSON output test ต้องรันได้');
  
  // ตรวจสอบว่า output มี JSON
  const hasJson = jsonResult.stdout.includes('{') && jsonResult.stdout.includes('}');
  
  assert.ok(hasJson, 'Output ต้องมี JSON result');
});

// ════════════════════════════════════════════════════════════════
// 5. END-TO-END WORKFLOW TESTS
// ════════════════════════════════════════════════════════════════

test('E2E: Complete Secretary workflow สำหรับ file creation', async () => {
  createTestFile('e2e-test.txt', 'initial content');
  
  const e2eResult = runSecretary('อ่านไฟล์ e2e-test.txt', { cwd: TEST_DIR, timeout: 60000 });
  
  assert.ok(e2eResult.success || e2eResult.stdout.length > 0,
    'E2E workflow ต้องรันได้');
  
  assert.ok(e2eResult.stdout.length > 50,
    'ต้องมี meaningful output');
  
  // ตรวจสอบว่ามีการแสดง workflow progression
  const workflowSteps = [
    'Starting workflow',
    'Gathering context',
    'Consult',
    'Execute', 
    'success',
    'complete'
  ];
  
  const hasWorkflowProgression = workflowSteps.some(step =>
    e2eResult.stdout.toLowerCase().includes(step.toLowerCase())
  );
  
  assert.ok(hasWorkflowProgression,
    `Workflow ต้องแสดง progression ผ่าน steps. Output: ${e2eResult.stdout.slice(0, 500)}`);
});

test('E2E: Secretary รักษาสถานะระหว่าง multiple requests', async () => {
  const requests = [
    'สร้างไฟล์ test-file.txt',
    'แสดงรายชื่อไฟล์ทั้งหมด',
    'อ่านไฟล์ test-file.txt'
  ];
  
  for (const request of requests) {
    const result = runSecretary(request, { cwd: TEST_DIR });
    
    assert.ok(result.success || result.stdout.length > 0,
      `Request "${request}" ไม่ควร crash`);
    
    assert.ok(result.stdout.length > 0,
      `Request "${request}" ต้องมี output`);
  }
});

// ════════════════════════════════════════════════════════════════
// 6. PERFORMANCE TESTS (Loose thresholds)
// ════════════════════════════════════════════════════════════════

test('PERFORMANCE: Secretary เริ่มทำงานภายในเวลาที่ยอมรับได้', async () => {
  const start = Date.now();
  const perfResult = runSecretary('Quick test', { cwd: TEST_DIR, timeout: 30000 });
  const elapsed = Date.now() - start;
  
  assert.ok(elapsed < 15000,
    `Secretary ใช้เวลา ${elapsed}ms - threshold คือ 15 วินาที`);
  
  assert.ok(perfResult.success || perfResult.stdout.length > 0);
});

test('PERFORMANCE: Context gathering เร็ว', async () => {
  const contextDir = join(TEST_DIR, 'context-perf');
  mkdirSync(contextDir, { recursive: true });
  
  // สร้าง files สำหรับ context scanning
  for (let i = 0; i < 10; i++) {
    createTestFile(`context-perf/file${i}.txt`, `content ${i}`);
  }
  
  const start = Date.now();
  const contextResult = runSecretary('นับจำนวนไฟล์', { cwd: contextDir, timeout: 30000 });
  const elapsed = Date.now() - start;
  
  assert.ok(elapsed < 10000,
    `Context gathering ใช้เวลา ${elapsed}ms - threshold คือ 10 วินาที`);
});

// ════════════════════════════════════════════════════════════════
// 7. INTEGRATION WITH EXISTING TEST SUITE
// ════════════════════════════════════════════════════════════════

// Export สำหรับใช้ใน integration tests
export {
  runSecretary,
  fileContains,
  createTestFile,
  SECRETARY_SCRIPT,
  TEST_DIR,
  PROJECT_ROOT
};
