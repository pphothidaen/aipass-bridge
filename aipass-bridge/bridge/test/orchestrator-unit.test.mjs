// Phase 1: Unit Tests for aipass-orchestrator
// Tests all core functions without external dependencies
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ──────────────────────────────────────────────────────────────────── Mock functions (copied from orchestrator)

function parseInstructions(text) {
  const lines = text.split('\n');
  const prose = [];
  const instructions = [];
  let i = 0;
  let foundInstruction = false;

  while (i < lines.length) {
    const line = lines[i];

    let m = /^\s*NEED\s+(dir|file)\s+(.+?)\s*$/i.exec(line);
    if (m) {
      foundInstruction = true;
      i++;
      instructions.push({ kind: m[1].toLowerCase() === 'dir' ? 'list' : 'read', arg: m[2].trim() });
      continue;
    }

    m = /^\s*SEARCH\s+(.+?)\s*$/i.exec(line);
    if (m) {
      foundInstruction = true;
      i++;
      instructions.push({ kind: 'search', arg: m[1].trim() });
      continue;
    }

    m = /^\s*EDIT\s+(.+?)\s*$/i.exec(line);
    if (m) {
      foundInstruction = true;
      i++;
      while (i < lines.length && !/^\s*FIND\s*$/i.test(lines[i])) i++;
      if (i < lines.length) i++;
      const before = [];
      while (i < lines.length && !/^\s*NEW\s*$/i.test(lines[i])) before.push(lines[i++]);
      if (i < lines.length) i++;
      const after = [];
      while (i < lines.length && !/^\s*END\s*$/i.test(lines[i])) after.push(lines[i++]);
      if (i < lines.length) i++;
      instructions.push({ kind: 'edit', arg: m[1].trim(), find: before.join('\n'), replace: after.join('\n') });
      continue;
    }

    m = /^\s*CREATE\s+(.+?)\s*$/i.exec(line);
    if (m) {
      foundInstruction = true;
      i++;
      const body = [];
      while (i < lines.length && !/^\s*END\s*$/i.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      instructions.push({ kind: 'create', arg: m[1].trim(), content: body.join('\n') });
      continue;
    }

    if (/^\s*RUN\s*$/i.test(line)) {
      foundInstruction = true;
      i++;
      const body = [];
      while (i < lines.length && !/^\s*END\s*$/i.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      instructions.push({ kind: 'run', arg: '', content: body.join('\n') });
      continue;
    }

    m = /^\s*DONE\b\s*(.*)$/i.exec(line);
    if (m) {
      foundInstruction = true;
      i++;
      instructions.push({ kind: 'done', arg: m[1].trim() });
      continue;
    }

    // If we found any instruction, stop collecting prose from subsequent lines
    if (foundInstruction) {
      i++;
      continue;
    }

    prose.push(line);
    i++;
  }

  return { prose: prose.join('\n').trim(), instructions };
}

function selectModel(userMsg, explicitModel) {
  const AIPASS_MODEL_CATALOG = {
    'gemini-3.1-flash-lite': { domain: 'general', free: true, speed: 'fast' },
    'claude-sonnet-5@default': { domain: 'general', free: false, speed: 'fast' },
    'claude-opus-5@azure': { domain: 'reasoning', free: false, speed: 'slow' },
    'gemini-3.1-pro-preview': { domain: 'reasoning', free: false, speed: 'medium' },
    'gpt-5.6-terra': { domain: 'general', free: false, speed: 'fast' },
    'gpt-5.6-sol': { domain: 'reasoning', free: false, speed: 'medium' },
    'grok-4.3': { domain: 'general', free: false, speed: 'fast' },
    'DeepSeek-V3.2': { domain: 'coding', free: false, speed: 'fast' },
    'gpt-image-2': { domain: 'image', free: false, speed: 'medium' },
    'gemini-3.1-flash-image': { domain: 'image', free: false, speed: 'fast' },
    'seedream-4.0': { domain: 'image', free: false, speed: 'medium' },
    'seedream-5.0-lite': { domain: 'image', free: false, speed: 'fast' },
    'veo-3.1-fast-generate-001': { domain: 'video', free: false, speed: 'fast' },
    'seedance-2.0-mini': { domain: 'video', free: false, speed: 'fast' },
    'seedance-2.0-fast': { domain: 'video', free: false, speed: 'fast' },
    'seedance-2.0': { domain: 'video', free: false, speed: 'medium' },
    'lyria-3-clip-preview': { domain: 'music', free: false, speed: 'medium' },
    'lyria-3-pro-preview': { domain: 'music', free: false, speed: 'slow' },
    'openai-deep-research': { domain: 'research', free: false, speed: 'slow' },
    'sonar-deep-research': { domain: 'research', free: false, speed: 'slow' },
    'sonar': { domain: 'web_search', free: false, speed: 'fast' },
    'sonar-reasoning-pro': { domain: 'web_search', free: false, speed: 'medium' },
  };

  if (explicitModel && AIPASS_MODEL_CATALOG[explicitModel]) return explicitModel;

  const msg = userMsg.toLowerCase();

  if (/generate.*image|สร้าง.*ภาพ|วาด.*ภาพ|image.*gen|draw|paint/i.test(msg)) return 'gpt-image-2';
  if (/generate.*video|สร้าง.*วิดีโอ|video.*gen|make.*video/i.test(msg)) return 'veo-3.1-fast-generate-001';
  if (/generate.*music|สร้าง.*เพลง|music.*gen|compose|song/i.test(msg)) return 'lyria-3-clip-preview';
  if (/research|deep.*search|ค้นคว้า|investigate/i.test(msg)) return 'sonar-deep-research';
  if (/search.*web|ค้นหา.*ข่าว|latest.*news|what.*happening/i.test(msg)) return 'sonar';
  if (/medical|health|diagnosis|patient|symptom|disease|condition|แพทย์|สุขภาพ|อาการ|โรค/i.test(msg)) return 'gemini-3.1-pro-preview';
  if (/finance|invest|stock|portfolio|การเงิน|ลงทุน|tax|budget/i.test(msg)) return 'gemini-3.1-pro-preview';
  if (/prove|theorem|logic|mathematics|derive|proof/i.test(msg)) return 'claude-opus-5@azure';
  if (/analyze|calculate|วิเคราะห์|คำนวณ|reason/i.test(msg)) return 'claude-opus-5@azure';
  if (/code|coding|program|function|class|api|refactor|debug|fix.*bug/i.test(msg)) return 'claude-sonnet-5@default';
  return 'claude-sonnet-5@default';
}

function instructionToToolCall(inst) {
  switch (inst.kind) {
    case 'read': return { name: 'read_file', arguments: { path: inst.arg } };
    case 'list': return { name: 'list_directory', arguments: { path: inst.arg } };
    case 'search': return { name: 'search_files', arguments: { pattern: inst.arg } };
    case 'edit': return { name: 'edit_file', arguments: { path: inst.arg, find: inst.find, replace: inst.replace } };
    case 'create': return { name: 'create_file', arguments: { path: inst.arg, content: inst.content } };
    case 'run': return { name: 'run_command', arguments: { command: inst.content } };
    default: return null;
  }
}

function aipassSaysCannot(text) {
  const CANNOT_PATTERNS = [
    /ไม่สามารถเข้าถึงไฟล์/i,
    /ไม่สามารถ.*ไฟล์.*ได้/i,
    /cannot access.*files?/i,
    /can'?t.*access.*files?/i,
    /don'?t.*have.*access/i,
    /no.*file.*access/i,
    /unable.*to.*read/i,
    /ไม่มี.*สิทธิ์.*เข้าถึง/i,
    /ไม่.*อ่าน.*ไฟล์.*ได้/i,
  ];
  return CANNOT_PATTERNS.some(re => re.test(text));
}

function userWantsFileOps(userMsg) {
  const FILE_OP_PATTERNS = [
    /read.*file/i, /อ่าน.*ไฟล์/i,
    /list.*dir/i, /list.*folder/i,
    /search.*in.*project/i, /find.*in.*code/i,
    /edit.*file/i, /แก้ไข.*ไฟล์/i,
    /create.*file/i, /สร้าง.*ไฟล์/i,
    /delete.*file/i, /ลบ.*ไฟล์/i,
    /package\.json/i, /manifest/i,
    /version.*project/i, /project.*structure/i,
    /โครงสร้าง.*โปรเจกต์/i, /ไฟล์.*ไหน/i,
  ];
  return FILE_OP_PATTERNS.some(re => re.test(userMsg));
}

// ──────────────────────────────────────────────────────────────────── Phase 1.1: Model Selection

test('Phase 1.1: selectModel - image generation', () => {
  assert.equal(selectModel('Generate an image of a cat'), 'gpt-image-2');
  assert.equal(selectModel('สร้างภาพแมว'), 'gpt-image-2');
  assert.equal(selectModel('Draw a sunset'), 'gpt-image-2');
  assert.equal(selectModel('Paint a landscape'), 'gpt-image-2');
});

test('Phase 1.1: selectModel - video generation', () => {
  assert.equal(selectModel('Generate a video of a sunset'), 'veo-3.1-fast-generate-001');
  assert.equal(selectModel('สร้างวิดีโอแมว'), 'veo-3.1-fast-generate-001');
  assert.equal(selectModel('Make a video'), 'veo-3.1-fast-generate-001');
});

test('Phase 1.1: selectModel - music generation', () => {
  assert.equal(selectModel('Generate music for relaxation'), 'lyria-3-clip-preview');
  assert.equal(selectModel('สร้างเพลง'), 'lyria-3-clip-preview');
  assert.equal(selectModel('Compose a song'), 'lyria-3-clip-preview');
});

test('Phase 1.1: selectModel - research', () => {
  assert.equal(selectModel('Research the latest AI trends'), 'sonar-deep-research');
  assert.equal(selectModel('Deep search for quantum computing'), 'sonar-deep-research');
  assert.equal(selectModel('Investigate climate change'), 'sonar-deep-research');
});

test('Phase 1.1: selectModel - web search', () => {
  assert.equal(selectModel('Search the web for latest news'), 'sonar');
  assert.equal(selectModel('ค้นหาข่าวล่าสุด'), 'sonar');
  assert.equal(selectModel('What is happening in tech?'), 'sonar');
});

test('Phase 1.1: selectModel - complex reasoning', () => {
  assert.equal(selectModel('Prove that P != NP'), 'claude-opus-5@azure');
  assert.equal(selectModel('Analyze this logical argument'), 'claude-opus-5@azure');
  assert.equal(selectModel('Calculate the trajectory'), 'claude-opus-5@azure');
  assert.equal(selectModel('วิเคราะห์ปัญหานี้'), 'claude-opus-5@azure');
  assert.equal(selectModel('Derive the equation'), 'claude-opus-5@azure');
  assert.equal(selectModel('What is the logic here?'), 'claude-opus-5@azure');
});

test('Phase 1.1: selectModel - coding', () => {
  assert.equal(selectModel('Write a Python function'), 'claude-sonnet-5@default');
  assert.equal(selectModel('Debug this code'), 'claude-sonnet-5@default');
  assert.equal(selectModel('Refactor this class'), 'claude-sonnet-5@default');
  assert.equal(selectModel('Fix the bug in this API'), 'claude-sonnet-5@default');
});

test('Phase 1.1: selectModel - finance', () => {
  assert.equal(selectModel('What stocks should I invest in?'), 'gemini-3.1-pro-preview');
  assert.equal(selectModel('Analyze my portfolio'), 'gemini-3.1-pro-preview');
  assert.equal(selectModel('การลงทุนในตลาดหุ้น'), 'gemini-3.1-pro-preview');
});

test('Phase 1.1: selectModel - medicine', () => {
  assert.equal(selectModel('What are the symptoms of diabetes?'), 'gemini-3.1-pro-preview');
  assert.equal(selectModel('Diagnose this patient'), 'gemini-3.1-pro-preview');
  assert.equal(selectModel('อาการของโรคหัวใจ'), 'gemini-3.1-pro-preview');
});

test('Phase 1.1: selectModel - general (default)', () => {
  assert.equal(selectModel('Hello, how are you?'), 'claude-sonnet-5@default');
  assert.equal(selectModel('What is the capital of France?'), 'claude-sonnet-5@default');
  assert.equal(selectModel('Tell me a joke'), 'claude-sonnet-5@default');
});

test('Phase 1.1: selectModel - explicit model override', () => {
  assert.equal(selectModel('Hello', 'gemini-3.1-flash-lite'), 'gemini-3.1-flash-lite');
  assert.equal(selectModel('Hello', 'gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(selectModel('Hello', 'DeepSeek-V3.2'), 'DeepSeek-V3.2');
});

test('Phase 1.1: selectModel - unknown explicit model falls back to default', () => {
  assert.equal(selectModel('Hello', 'unknown-model'), 'claude-sonnet-5@default');
});

// ──────────────────────────────────────────────────────────────────── Phase 1.2: Instruction Parsing

test('Phase 1.2: parseInstructions - NEED file', () => {
  const result = parseInstructions('NEED file /tmp/test.txt');
  assert.equal(result.instructions.length, 1);
  assert.equal(result.instructions[0].kind, 'read');
  assert.equal(result.instructions[0].arg, '/tmp/test.txt');
  assert.equal(result.prose, '');
});

test('Phase 1.2: parseInstructions - NEED dir', () => {
  const result = parseInstructions('NEED dir /home/user');
  assert.equal(result.instructions.length, 1);
  assert.equal(result.instructions[0].kind, 'list');
  assert.equal(result.instructions[0].arg, '/home/user');
});

test('Phase 1.2: parseInstructions - SEARCH', () => {
  const result = parseInstructions('SEARCH TODO in codebase');
  assert.equal(result.instructions.length, 1);
  assert.equal(result.instructions[0].kind, 'search');
  assert.equal(result.instructions[0].arg, 'TODO in codebase');
});

test('Phase 1.2: parseInstructions - EDIT with FIND/NEW', () => {
  const text = `EDIT src/app.ts
FIND
const x = 1;
NEW
const x = 2;
END`;
  const result = parseInstructions(text);
  assert.equal(result.instructions.length, 1);
  assert.equal(result.instructions[0].kind, 'edit');
  assert.equal(result.instructions[0].arg, 'src/app.ts');
  assert.equal(result.instructions[0].find, 'const x = 1;');
  assert.equal(result.instructions[0].replace, 'const x = 2;');
});

test('Phase 1.2: parseInstructions - CREATE', () => {
  const text = `CREATE notes.md
# Notes
This is a note.
END`;
  const result = parseInstructions(text);
  assert.equal(result.instructions.length, 1);
  assert.equal(result.instructions[0].kind, 'create');
  assert.equal(result.instructions[0].arg, 'notes.md');
  assert.ok(result.instructions[0].content.includes('# Notes'));
});

test('Phase 1.2: parseInstructions - RUN', () => {
  const text = `RUN
ls -la
END`;
  const result = parseInstructions(text);
  assert.equal(result.instructions.length, 1);
  assert.equal(result.instructions[0].kind, 'run');
  assert.equal(result.instructions[0].content, 'ls -la');
});

test('Phase 1.2: parseInstructions - DONE', () => {
  const result = parseInstructions('DONE Finished the task');
  assert.equal(result.instructions.length, 1);
  assert.equal(result.instructions[0].kind, 'done');
  assert.equal(result.instructions[0].arg, 'Finished the task');
  assert.equal(result.prose, '');
});

test('Phase 1.2: parseInstructions - prose only (no instructions)', () => {
  const result = parseInstructions('Hello, I am doing well.');
  assert.equal(result.instructions.length, 0);
  assert.equal(result.prose, 'Hello, I am doing well.');
});

test('Phase 1.2: parseInstructions - mixed prose and instructions', () => {
  const text = `Let me help you with that.
NEED file /tmp/test.txt
DONE Here is the result`;
  const result = parseInstructions(text);
  assert.equal(result.prose, 'Let me help you with that.');
  assert.equal(result.instructions.length, 2);
  assert.equal(result.instructions[0].kind, 'read');
  assert.equal(result.instructions[1].kind, 'done');
  assert.equal(result.instructions[1].arg, 'Here is the result');
});

test('Phase 1.2: parseInstructions - multiple instructions', () => {
  const text = `NEED file /tmp/a.txt
NEED file /tmp/b.txt
SEARCH TODO`;
  const result = parseInstructions(text);
  assert.equal(result.instructions.length, 3);
  assert.equal(result.instructions[0].kind, 'read');
  assert.equal(result.instructions[1].kind, 'read');
  assert.equal(result.instructions[2].kind, 'search');
});

test('Phase 1.2: parseInstructions - empty input', () => {
  const result = parseInstructions('');
  assert.equal(result.instructions.length, 0);
  assert.equal(result.prose, '');
});

test('Phase 1.2: parseInstructions - whitespace only', () => {
  const result = parseInstructions('   \n   \n   ');
  assert.equal(result.instructions.length, 0);
  assert.equal(result.prose.trim(), '');
});

// ──────────────────────────────────────────────────────────────────── Phase 1.3: Capability Detection

test('Phase 1.3: capability detection - cannot access files (Thai)', () => {
  assert.ok(aipassSaysCannot('ผมไม่สามารถเข้าถึงไฟล์ได้'));
  assert.ok(aipassSaysCannot('ไม่สามารถเข้าถึงไฟล์จากเส้นทาง'));
  assert.ok(aipassSaysCannot('ไม่มีสิทธิ์เข้าถึงไฟล์'));
  assert.ok(aipassSaysCannot('ไม่สามารถอ่านไฟล์ได้'));
});

test('Phase 1.3: capability detection - cannot access files (English)', () => {
  assert.ok(aipassSaysCannot('I cannot access files'));
  assert.ok(aipassSaysCannot("I can't access your files"));
  assert.ok(aipassSaysCannot("I don't have access to files"));
  assert.ok(aipassSaysCannot('No file access available'));
  assert.ok(aipassSaysCannot('Unable to read files'));
});

test('Phase 1.3: capability detection - normal responses (should NOT match)', () => {
  assert.ok(!aipassSaysCannot('I can help you with that'));
  assert.ok(!aipassSaysCannot('Here is the file content'));
  assert.ok(!aipassSaysCannot('ผมช่วยคุณได้'));
  assert.ok(!aipassSaysCannot('The file is ready'));
});

test('Phase 1.3: userWantsFileOps - read file', () => {
  assert.ok(userWantsFileOps('Read the file /tmp/test.txt'));
  assert.ok(userWantsFileOps('อ่านไฟล์ /tmp/test.txt'));
});

test('Phase 1.3: userWantsFileOps - list directory', () => {
  assert.ok(userWantsFileOps('List directory /home/user'));
  assert.ok(userWantsFileOps('List folder /tmp'));
});

test('Phase 1.3: userWantsFileOps - search in project', () => {
  assert.ok(userWantsFileOps('Search in project for TODO'));
  assert.ok(userWantsFileOps('Find in code for function'));
});

test('Phase 1.3: userWantsFileOps - edit file', () => {
  assert.ok(userWantsFileOps('Edit the file /tmp/test.txt'));
  assert.ok(userWantsFileOps('แก้ไขไฟล์ /tmp/test.txt'));
});

test('Phase 1.3: userWantsFileOps - create file', () => {
  assert.ok(userWantsFileOps('Create a new file /tmp/test.txt'));
  assert.ok(userWantsFileOps('สร้างไฟล์ /tmp/test.txt'));
});

test('Phase 1.3: userWantsFileOps - delete file', () => {
  assert.ok(userWantsFileOps('Delete the file /tmp/test.txt'));
  assert.ok(userWantsFileOps('ลบไฟล์ /tmp/test.txt'));
});

test('Phase 1.3: userWantsFileOps - package.json', () => {
  assert.ok(userWantsFileOps('Read package.json'));
  assert.ok(userWantsFileOps('What is the version in package.json?'));
});

test('Phase 1.3: userWantsFileOps - project structure', () => {
  assert.ok(userWantsFileOps('Show project structure'));
  assert.ok(userWantsFileOps('โครงสร้างโปรเจกต์'));
});

test('Phase 1.3: userWantsFileOps - normal queries (should NOT match)', () => {
  assert.ok(!userWantsFileOps('Hello, how are you?'));
  assert.ok(!userWantsFileOps('What is 2+2?'));
  assert.ok(!userWantsFileOps('Tell me a joke'));
});

// ──────────────────────────────────────────────────────────────────── Phase 1.4: Tool Mapping

test('Phase 1.4: tool mapping - read_file', () => {
  const inst = { kind: 'read', arg: '/tmp/test.txt' };
  const tc = instructionToToolCall(inst);
  assert.equal(tc.name, 'read_file');
  assert.equal(tc.arguments.path, '/tmp/test.txt');
});

test('Phase 1.4: tool mapping - list_directory', () => {
  const inst = { kind: 'list', arg: '/home/user' };
  const tc = instructionToToolCall(inst);
  assert.equal(tc.name, 'list_directory');
  assert.equal(tc.arguments.path, '/home/user');
});

test('Phase 1.4: tool mapping - search_files', () => {
  const inst = { kind: 'search', arg: 'TODO' };
  const tc = instructionToToolCall(inst);
  assert.equal(tc.name, 'search_files');
  assert.equal(tc.arguments.pattern, 'TODO');
});

test('Phase 1.4: tool mapping - edit_file', () => {
  const inst = { kind: 'edit', arg: 'src/app.ts', find: 'old', replace: 'new' };
  const tc = instructionToToolCall(inst);
  assert.equal(tc.name, 'edit_file');
  assert.equal(tc.arguments.path, 'src/app.ts');
  assert.equal(tc.arguments.find, 'old');
  assert.equal(tc.arguments.replace, 'new');
});

test('Phase 1.4: tool mapping - create_file', () => {
  const inst = { kind: 'create', arg: 'notes.md', content: '# Hello' };
  const tc = instructionToToolCall(inst);
  assert.equal(tc.name, 'create_file');
  assert.equal(tc.arguments.path, 'notes.md');
  assert.equal(tc.arguments.content, '# Hello');
});

test('Phase 1.4: tool mapping - run_command', () => {
  const inst = { kind: 'run', arg: '', content: 'ls -la' };
  const tc = instructionToToolCall(inst);
  assert.equal(tc.name, 'run_command');
  assert.equal(tc.arguments.command, 'ls -la');
});

test('Phase 1.4: tool mapping - unknown kind returns null', () => {
  const inst = { kind: 'unknown', arg: 'test' };
  const tc = instructionToToolCall(inst);
  assert.equal(tc, null);
});

test('Phase 1.4: tool mapping - done kind returns null', () => {
  const inst = { kind: 'done', arg: 'Finished' };
  const tc = instructionToToolCall(inst);
  assert.equal(tc, null);
});