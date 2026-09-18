# aipass-orchestrator Test Workflow

## 🎯 วัตถุประสงค์
ตรวจสอบว่า orchestrator ทำงานถูกต้องตาม design: aipass = Orchestrator/Brain → fallback = longcat Executor

## 🏗️ สถาปัตยกรรมที่ต้องตรวจสอบ

```
Hermes → orchestrator (:8788) → aipass bridge (:8787) → de.aipass.net
                              ↓ (fallback)
                         longcat-2.0:free (JWT token)
```

## 📋 Test Workflow (เรียงลำดับ)

### Phase 1: Unit Tests (ไม่ต้องมี bridge)
- [ ] 1.1  model selection (image/video/coding/reasoning/finance/medicine)
- [ ] 1.2  instruction parsing (NEED/SEARCH/EDIT/CREATE/RUN/DONE)
- [ ] 1.3  capability detection (cannot access files)
- [ ] 1.4  tool mapping (read_file/search_files/edit_file/create_file/run_command)
- [ ] 1.5  JWT token reading from auth.json

### Phase 2: Integration Tests (ต้องมี bridge + extension)
- [ ] 2.1  health endpoint
- [ ] 2.2  models endpoint
- [ ] 2.3  simple query → aipass ตอบตรง ๆ
- [ ] 2.4  file read → aipass บอก "cannot" → fallback → longcat อ่านได้
- [ ] 2.5  image generation → gpt-image-2
- [ ] 2.6  explicit model override

### Phase 3: Hermes End-to-End (ต้องมี Hermes + bridge + extension)
- [ ] 3.1  hermes --provider aipass → simple query
- [ ] 3.2  hermes --provider aipass → file read (fallback)
- [ ] 3.3  hermes --provider aipass → image generation
- [ ] 3.4  multi-turn conversation

### Phase 4: Auto-start (LaunchAgent)
- [ ] 4.1  LaunchAgent starts on load
- [ ] 4.2  auto-restart after kill
- [ ] 4.3  Hermes connects after restart

---

## 🔧 สถานะปัจจุบัน

| Component | Status |
|-----------|--------|
| aipass-orchestrator.mjs | ✅ รันได้ที่ :8788 |
| aipass bridge | ✅ รันได้ที่ :8787 |
| Chrome extension | ✅ connected |
| LaunchAgent | ✅ loaded |
| Hermes config | ✅ aipass provider added |
| Fallback (JWT) | ✅ ทำงาน |

---

## ⚠️ ข้อจำกัด

- บาง tests ต้องมี bridge + extension ทำงาน
- บาง tests ต้องมี Hermes app
- บาง tests ใช้เวลานาน (image/video generation)

---

## 🚀 เริ่มทำตามลำดับ

### Step 1: Unit Tests (ไม่ต้องมี external)
```bash
cd packages/core/aipass-bridge
node --test bridge/test/orchestrator.test.mjs
```

### Step 2: Integration Tests (ต้องมี bridge)
```bash
# Start bridge first
cd packages/core/aipass-bridge && npm run dev &

# Then run integration tests
node --test bridge/test/integration.test.mjs
```

### Step 3: Hermes E2E
```bash
hermes --provider aipass --model claude-sonnet-5@default chat -q "Hello"
```

### Step 4: Auto-start verification
```bash
launchctl list | grep aipass
```
