// BridgeDO — Stateful Coordinator for Aipass Web Bridge
// Mirrors Gemini Web Bridge's GeminiBridgeDO (Cloudflare Durable Object)
// แต่ run บน Node.js และใช้ SSE แทน WSS (browser extension reachability)

import { randomUUID } from 'node:crypto';
import { ProtocolDecoder, ProtocolV2, PROTOCOL_VERSION, validateMessage } from './protocol-v2.mjs';

const QUEUE_MAX = 10;
const QUEUE_TIMEOUT_MS = 60_000;
const GENERATION_DEADLINE_MS = 60_000;

// ─── Cloudflare 403 Circuit Breaker ─────────────────────────────────────────
// Detects Cloudflare 403 responses from the extension, pauses the request
// queue, and applies exponential backoff before allowing retries.
const CIRCUIT_BREAKER_BACKOFF_STEPS = [1000, 2000, 4000, 8000]; // ms
const CIRCUIT_BREAKER_MAX_BACKOFF = 30_000; // cap at 30s
const CIRCUIT_BREAKER_RESET_TIMEOUT = 60_000; // auto-reset after 60s of no 403s

function isCloudflare403(message) {
  const text = String(message ?? '');
  return /(?:aipass returned|returned) 403\b/i.test(text)
    && /cloudflare|cf-ray|attention required/i.test(text);
}

export class BridgeDO {
  constructor() {
    // SSE clients (extension connections) — like WebSocket pair in Gemini
    this.sseClients = new Map(); // clientId -> { id, write, closed }
    this.activeClient = null;    // current leader SSE client (single active bridge tab)

    // State
    this.currentTokens = null;
    this.activeBrowserModel = null;
    this.extendedThinkingActive = false;
    this.dynamicModels = [];
    this.protocolVersion = 0;
    this.enforcementMode = 'strict';
    this.catalogRevision = randomUUID();
    // Monotonic epoch counter — incremented on every client add/remove
    // to prevent epoch collision when rapid reconnects occur in same millisecond.
    this.epochCounter = Date.now();
    this.sessionEpoch = this.epochCounter;

    // Queue
    this.pendingRequests = [];
    this.requestBusy = false;

    // Active streams (in-flight requests)
    this.activeStreams = new Map(); // requestId -> handler(fn)

    // Conversation state (for multi-turn)
    this.conversationState = {
      conversationId: null,
      responseId: null,
      choiceId: null,
    };

    // Generation evidence registry (mirror of Gemini's evidence-registry.js)
    this.evidenceRegistry = new Map(); // generationId -> { sessionEpoch, model, mappingRevision, timestamp }

    // ─── Cloudflare 403 Circuit Breaker ─────────────────────────────────────
    this.circuitBreaker = {
      isOpen: false,                    // true when queue is paused
      failureCount: 0,                  // consecutive 403 count for backoff
      lastFailureAt: 0,                 // timestamp of last 403
      resumeAt: 0,                      // timestamp when backoff expires
      totalPaused: 0,                   // total times circuit opened
    };

    // Keepalive
    this.keepaliveTimer = null;
    this.startKeepalive();
  }

  // ─── Model Catalog ──────────────────────────────────────────────────────────

  resetModelCatalog() {
    this.dynamicModels = [];
    this.activeBrowserModel = null;
    this.extendedThinkingActive = false;
    this.catalogRevision = randomUUID();
  }

  replaceModelCatalog(msg) {
    const next = (msg.models || []).map(m => ({
      id: m.id,
      name: m.name || m.id,
      provider: m.provider || null,
      kind: m.kind || 'chat',
      free: m.free_credit === true || m.free === true,
      ready: m.ready !== false,
      selectable: m.selectable !== false,
      isDefault: m.is_default === true,
      thinking: m.thinking || null,
      options: m.options || null,
      object: 'model',
      created: 0,
      owned_by: m.owned_by || 'aipass',
    }));
    const changed = JSON.stringify(next) !== JSON.stringify(this.dynamicModels);
    this.dynamicModels = next;
    if (typeof msg.protocolVersion === 'number') this.protocolVersion = msg.protocolVersion;
    if (msg.enforcementMode) this.enforcementMode = msg.enforcementMode === 'permissive' ? 'permissive' : 'strict';
    if (typeof msg.activeModel === 'string') this.activeBrowserModel = msg.activeModel;
    if (msg.extendedThinking === true) this.extendedThinkingActive = true;
    if (changed) this.catalogRevision = randomUUID();
  }

  /** คำนวณ default model จาก catalog (Gemini: recommendedModel) */
  recommendedModel() {
    // เลือก model แรกที่ isDefault, หรือ model แรกในรายการ
    return (
      this.dynamicModels.find(m => m.isDefault) ??
      this.dynamicModels.find(m => m.kind === 'chat') ??
      this.dynamicModels[0]?.id ??
      null
    );
  }

  // ─── Connection Management ──────────────────────────────────────────────────

  /** Check ว่า extension เชื่อมต่ออยู่ไหม (เหมือน Gemini: isExtensionReady) */
  isExtensionReady() {
    return this.activeClient != null && !this.activeClient.closed;
  }

  /** Register SSE client (extension connect) */
  addClient(client) {
    // Invalidate previous active client if any
    if (this.activeClient && this.activeClient !== client) {
      this.activeClient.closed = true;
      // Fail all pending streams
      for (const handler of this.activeStreams.values()) {
        handler({ type: ProtocolV2.STREAM_ERROR, error: 'Extension reconnected' });
      }
      for (const entry of this.pendingRequests.splice(0)) {
        entry.reject(new Error('extension_reconnected'));
      }
      this.resetModelCatalog();
    }

    this.activeClient = client;
    this.sseClients.set(client.id, client);
    // Monotonic epoch: increment counter to prevent same-ms collision
    this.epochCounter += 1;
    this.sessionEpoch = this.epochCounter;
    this.invalidateAllEvidence();

    // Notify client that session is ready
    this.sendToClient(client, ProtocolV2.SESSION_READY, {
      sessionEpoch: this.sessionEpoch,
      buildLabel: 'aipass-bridge-v1',
      protocolVersion: PROTOCOL_VERSION,
    });

    // Send current model catalog (if any)
    if (this.dynamicModels.length > 0) {
      this.sendToClient(client, ProtocolV2.MODELS_DISCOVERED, {
        models: this.dynamicModels,
        protocolVersion: this.protocolVersion,
        enforcementMode: this.enforcementMode,
        activeModel: this.activeBrowserModel,
        extendedThinking: this.extendedThinkingActive,
      });
    }

    return client;
  }

  /** Remove SSE client (extension disconnect) */
  removeClient(client) {
    this.sseClients.delete(client.id);
    if (this.activeClient === client) {
      this.activeClient = null;
      this.currentTokens = null;
      this.protocolVersion = 0;
      // Monotonic epoch: increment counter to prevent same-ms collision
      this.epochCounter += 1;
      this.sessionEpoch = this.epochCounter;
      this.invalidateAllEvidence();
      this.resetModelCatalog();

      // Fail all pending streams
      for (const handler of this.activeStreams.values()) {
        handler({ type: ProtocolV2.STREAM_ERROR, error: 'Extension disconnected' });
      }
      this.activeStreams.clear();

      // Reject pending queue
      for (const entry of this.pendingRequests.splice(0)) {
        entry.reject(new Error('extension_disconnected'));
      }
      this.requestBusy = false;
    }
  }

  /** Send message to specific SSE client */
  sendToClient(client, type, payload = {}) {
    if (client.closed) return;
    try {
      client.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch { /* client closed */ }
  }

  /** Broadcast to all clients */
  broadcast(type, payload = {}) {
    for (const client of this.sseClients.values()) {
      this.sendToClient(client, type, payload);
    }
  }

  // ─── Keepalive ──────────────────────────────────────────────────────────────

  startKeepalive() {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.activeClient && !this.activeClient.closed) {
        this.sendToClient(this.activeClient, ProtocolV2.PING);
      }
    }, 15_000);
    this.keepaliveTimer.unref?.();
  }

  stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  // ─── Request Execution ──────────────────────────────────────────────────────

  /**
   * Execute request through extension (เหมือน Gemini: executeThroughExtension).
   * Returns Promise<string> — full text response.
   */
  async executeThroughExtension(messages, onChunk, model = '') {
    if (!this.isExtensionReady()) {
      const err = new Error('Extension not connected');
      err.code = 'extension_disconnected';
      throw err;
    }

    const requestId = `req_${randomUUID()}`;
    const encodedReq = ProtocolDecoder.encodeRequest(messages, this.conversationState, model);

    return new Promise((resolve, reject) => {
      let fullText = '';
      let rpcBuffer = '';

      const timer = setTimeout(() => {
        this.activeStreams.delete(requestId);
        reject(new Error('Timeout waiting for response from extension (60s)'));
      }, GENERATION_DEADLINE_MS);

      const handler = (msg) => {
        if (msg.type === ProtocolV2.STREAM_CHUNK && msg.chunk) {
          rpcBuffer += msg.chunk;
          // Decode complete RPC lines only
          const boundary = rpcBuffer.lastIndexOf('\n');
          if (boundary >= 0) {
            const { deltaText } = ProtocolDecoder.decodeChunk(rpcBuffer.slice(0, boundary + 1));
            rpcBuffer = rpcBuffer.slice(boundary + 1);
            if (deltaText) {
              fullText = deltaText;
              onChunk?.(deltaText, deltaText);
            }
          }
        } else if (msg.type === ProtocolV2.STREAM_DONE) {
          clearTimeout(timer);
          this.activeStreams.delete(requestId);
          const { deltaText } = ProtocolDecoder.decodeChunk(rpcBuffer);
          if (deltaText) fullText = deltaText;
          Promise.resolve().then(() => onChunk?.(fullText, fullText)).then(() => resolve(fullText), reject);
        } else if (msg.type === ProtocolV2.STREAM_ERROR) {
          clearTimeout(timer);
          this.activeStreams.delete(requestId);
          reject(Object.assign(new Error(msg.error || 'Execution error in extension'), {
            code: msg.code || 'execution_failed'
          }));
        }
      };

      this.activeStreams.set(requestId, handler);

      try {
        this.sendToClient(this.activeClient, ProtocolV2.EXECUTE_REQUEST, {
          requestId,
          payload: {
            f_req: encodedReq,
            model,
            protocolVersion: PROTOCOL_VERSION,
            catalogRevision: this.catalogRevision,
            mappingRevision: this.dynamicModels.find(m => m.id === model)?.options?.mapping_revision,
          },
        });
      } catch (err) {
        clearTimeout(timer);
        this.activeStreams.delete(requestId);
        reject(err);
      }
    });
  }

  // ─── Model Preparation (PREPARE_MODEL / MODEL_READY) ────────────────────────

  async prepareModel(model) {
    if (!this.isExtensionReady()) {
      const err = new Error('Extension not connected');
      err.code = 'extension_disconnected';
      throw err;
    }

    const catalogEntry = this.dynamicModels.find((entry) => entry.id === model);
    if (!catalogEntry || catalogEntry.ready === false || catalogEntry.selectable === false) {
      throw Object.assign(new Error(`Model unverified: ${model}`), { code: 'model_unverified' });
    }

    const requestId = `prepare_${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activeStreams.delete(requestId);
        reject(Object.assign(new Error('Model mapping could not be verified'), { code: 'model_unverified' }));
      }, 11_000);

      const handler = (msg) => {
        if (![ProtocolV2.MODEL_READY, ProtocolV2.STREAM_ERROR].includes(msg.type)) return;
        clearTimeout(timer);
        this.activeStreams.delete(requestId);
        if (msg.type === ProtocolV2.STREAM_ERROR) {
          reject(Object.assign(new Error(msg.error || 'Model unverified'), { code: msg.code || 'model_unverified' }));
        } else {
          if (msg.sessionEpoch != null && msg.sessionEpoch !== this.sessionEpoch) {
            reject(Object.assign(new Error('Model readiness belongs to a stale session'), { code: 'session_epoch_mismatch' }));
          } else {
            resolve(msg);
          }
        }
      };

      this.activeStreams.set(requestId, handler);

      try {
        this.sendToClient(this.activeClient, ProtocolV2.PREPARE_MODEL, {
          requestId,
          model,
          catalogRevision: this.catalogRevision,
        });
      } catch (error) {
        clearTimeout(timer);
        this.activeStreams.delete(requestId);
        reject(error);
      }
    });
  }

  // ─── Queue Management (FIFO, like Gemini) ───────────────────────────────────

  async enqueueRequest() {
    if (this.requestBusy) {
      if (this.pendingRequests.length >= QUEUE_MAX) {
        const err = new Error('Browser request queue is full');
        err.code = 'queue_full';
        throw err;
      }
      await new Promise((resolve, reject) => {
        const entry = {
          resolve: () => { clearTimeout(entry.timer); resolve(); },
          reject: (reason) => { clearTimeout(entry.timer); reject(reason); },
        };
        entry.timer = setTimeout(() => {
          this.pendingRequests = this.pendingRequests.filter(x => x !== entry);
          reject(new Error('queue_timeout'));
        }, QUEUE_TIMEOUT_MS);
        entry.timer.unref?.();
        this.pendingRequests.push(entry);
      });
    } else {
      this.requestBusy = true;
    }
  }

  /**
   * Execute a high-level page job over the Protocol v2 bridge channel.
   * The page owns the authenticated request and returns structured stream parts;
   * this coordinator owns admission, epoch validation, and lifecycle cleanup.
   */
  async executeJob(job, onPart) {
    if (!this.isExtensionReady()) {
      throw Object.assign(new Error('Extension not connected'), { code: 'extension_disconnected' });
    }
    const model = String(job.modelId ?? '');
    const catalogEntry = this.dynamicModels.find((entry) => entry.id === model);
    if (!catalogEntry || catalogEntry.ready === false || catalogEntry.selectable === false) {
      throw Object.assign(new Error(`Model unverified: ${model}`), { code: 'model_unverified' });
    }

    const ready = await this.prepareModel(model);
    const requestId = `req_${randomUUID()}`;
    const sessionEpoch = this.sessionEpoch;
    const mappingRevision = ready.mappingRevision ?? null;
    this.registerEvidence(requestId, model, sessionEpoch, mappingRevision);

    return new Promise((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(() => finish(reject, Object.assign(
        new Error('Timeout waiting for response from extension (60s)'),
        { code: 'execution_timeout' },
      )), GENERATION_DEADLINE_MS);

      const finish = (fn, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.activeStreams.delete(requestId);
        if (fn === reject) this.evidenceRegistry.delete(requestId);
        fn(value);
      };

      const handler = (msg) => {
        if (msg.sessionEpoch != null && msg.sessionEpoch !== sessionEpoch) {
          return finish(reject, Object.assign(new Error('Stream belongs to a stale session'), { code: 'session_epoch_mismatch' }));
        }
        if (!this.validateEvidence(requestId, this.sessionEpoch)) {
          return finish(reject, Object.assign(new Error('Generation evidence is stale'), { code: 'evidence_invalid' }));
        }
        if (msg.type === ProtocolV2.STREAM_CHUNK) {
          if (Array.isArray(msg.parts)) msg.parts.forEach((part) => onPart?.(part));
          else if (typeof msg.chunk === 'string') onPart?.({ kind: 'text', text: msg.chunk });
        } else if (msg.type === ProtocolV2.STREAM_DONE) {
          finish(resolve, msg.finishReason ?? 'stop');
        } else if (msg.type === ProtocolV2.STREAM_ERROR) {
          finish(reject, Object.assign(new Error(msg.error || 'Execution error in extension'), {
            code: msg.code || 'execution_failed',
          }));
        }
      };

      this.activeStreams.set(requestId, handler);
      try {
        this.sendToClient(this.activeClient, ProtocolV2.EXECUTE_REQUEST, {
          requestId,
          sessionEpoch,
          payload: {
            job: { ...job, jobId: requestId, requestId, sessionEpoch },
            model,
            protocolVersion: PROTOCOL_VERSION,
            catalogRevision: this.catalogRevision,
            mappingRevision,
          },
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  dequeueRequest() {
    const next = this.pendingRequests.shift();
    if (next) next.resolve();
    else this.requestBusy = false;
  }

  // ─── Cancellation ───────────────────────────────────────────────────────────

  cancelRequest(requestId) {
    const handler = this.activeStreams.get(requestId);
    if (handler) {
      this.activeStreams.delete(requestId);
      handler({ type: ProtocolV2.STREAM_ERROR, error: 'Request cancelled', code: 'cancelled' });
    }
  }

  // ─── Cloudflare 403 Circuit Breaker ─────────────────────────────────────────

  /**
   * Record a Cloudflare 403 failure. Opens the circuit (pauses queue) and
   * sets an exponential backoff timer.
   */
  recordCloudflare403() {
    const cb = this.circuitBreaker;
    cb.failureCount++;
    cb.lastFailureAt = Date.now();
    if (!cb.isOpen) {
      cb.isOpen = true;
      cb.totalPaused++;
    }
    // Exponential backoff: 1s, 2s, 4s, 8s, then capped at 30s
    const stepIndex = Math.min(cb.failureCount - 1, CIRCUIT_BREAKER_BACKOFF_STEPS.length - 1);
    const backoff = Math.min(
      CIRCUIT_BREAKER_BACKOFF_STEPS[stepIndex] ?? CIRCUIT_BREAKER_MAX_BACKOFF,
      CIRCUIT_BREAKER_MAX_BACKOFF,
    );
    cb.resumeAt = Date.now() + backoff;
    return { backoff, isOpen: true, failureCount: cb.failureCount };
  }

  /**
   * Record a successful response. Resets the circuit breaker to closed state.
   */
  recordSuccess() {
    const cb = this.circuitBreaker;
    if (cb.isOpen) {
      cb.isOpen = false;
      cb.failureCount = 0;
      cb.resumeAt = 0;
    }
  }

  /**
   * Check if the circuit breaker currently blocks new requests.
   * Returns { blocked: boolean, remainingMs: number }.
   */
  isCircuitBlocked() {
    const cb = this.circuitBreaker;
    if (!cb.isOpen) return { blocked: false, remainingMs: 0 };

    const now = Date.now();
    if (now >= cb.resumeAt) {
      // Backoff elapsed — auto-resume
      cb.isOpen = false;
      cb.failureCount = 0;
      cb.resumeAt = 0;
      return { blocked: false, remainingMs: 0 };
    }
    return { blocked: true, remainingMs: cb.resumeAt - now };
  }

  /**
   * Manually reset the circuit breaker (e.g., after tab refresh by user).
   */
  resetCircuitBreaker() {
    this.circuitBreaker.isOpen = false;
    this.circuitBreaker.failureCount = 0;
    this.circuitBreaker.resumeAt = 0;
    this.circuitBreaker.lastFailureAt = 0;
  }

  // ─── Evidence Registry ──────────────────────────────────────────────────────

  /**
   * Register generation evidence (like Gemini's evidence-registry.js).
   * ผูก generation กับ sessionEpoch — หาก sessionEpoch เปลี่ยนโดยไม่ sync, evidence ล้าสมัย.
   */
  registerEvidence(generationId, model, sessionEpoch, mappingRevision) {
    this.evidenceRegistry.set(generationId, {
      sessionEpoch,
      model,
      mappingRevision,
      timestamp: Date.now(),
    });
  }

  /**
   * Check ว่า generation evidence ยัง valid อยู่ไหม
   * ( sessionEpoch ตรงกับปัจจุบัน, ไม่ expired )
   */
  validateEvidence(generationId, currentSessionEpoch) {
    const ev = this.evidenceRegistry.get(generationId);
    if (!ev) return false;
    if (ev.sessionEpoch !== currentSessionEpoch) return false; // session changed
    if (Date.now() - ev.timestamp > 300_000) return false; // 5 นาที expiry
    return true;
  }

  /** Invalidate all evidence when session changes */
  invalidateAllEvidence() {
    this.evidenceRegistry.clear();
  }

  /**
   * Handle a Cloudflare 403 error. Records the failure in the circuit breaker,
   * opens the circuit (pauses queue), and emits a 'circuit_open' SSE event.
   * Returns the circuit breaker state.
   */
  handleCloudflare403(requestId) {
    const result = this.recordCloudflare403();
    this.broadcast('circuit_open', {
      reason: 'cloudflare_403',
      requestId,
      backoff: result.backoff,
      failureCount: result.failureCount,
      resumeAt: this.circuitBreaker.resumeAt,
    });
    return { ...result, resumeAt: this.circuitBreaker.resumeAt };
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────────

  destroy() {
    this.stopKeepalive();
    for (const entry of this.pendingRequests) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.sseClients.clear();
    this.activeStreams.clear();
    this.pendingRequests = [];
    this.requestBusy = false;
    this.activeClient = null;
    this.conversationState = { conversationId: null, responseId: null, choiceId: null };
    this.evidenceRegistry.clear();
  }
}

// PROTOCOL_VERSION is imported from protocol-v2.mjs at the top of this file
