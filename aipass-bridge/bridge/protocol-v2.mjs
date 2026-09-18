// Protocol v2 message types and validation for Aipass Web Bridge
// Mirrors Gemini Web Bridge's Protocol v2 but adapted for de.aipass.net target

// ─── Protocol v2 Message Types ──────────────────────────────────────────────────

/** 메시지는 Extension ↔ BridgeDO ระหว่างส่งผ่าน SSE (หรือ WSS ใน Gemini) */
const ProtocolV2 = {
  // Extension → BridgeDO
  SESSION_READY:    'SESSION_READY',     // { buildLabel, sessionEpoch, tokens? }
  MODELS_DISCOVERED:'MODELS_DISCOVERED',  // { models:[], protocolVersion, enforcementMode?, activeModel?, extendedThinking? }

  // BridgeDO → Extension
  PREPARE_MODEL:    'PREPARE_MODEL',     // { requestId, model, catalogRevision }
  MODEL_READY:      'MODEL_READY',       // { requestId, model, mappingRevision } — sent by extension back

  // BridgeDO → Extension (execution)
  EXECUTE_REQUEST:  'EXECUTE_REQUEST',   // { requestId, payload:{ f_req, model, protocolVersion, catalogRevision, mappingRevision } }

  // Extension → BridgeDO (streaming)
  STREAM_CHUNK:     'STREAM_CHUNK',      // { requestId, chunk:string }
  STREAM_DONE:      'STREAM_DONE',       // { requestId }
  STREAM_ERROR:     'STREAM_ERROR',      // { requestId, error?, code? }

  // BridgeDO → Extension
  CANCEL_REQUEST:   'CANCEL_REQUEST',    // { requestId }

  // Heartbeat
  PING:             'PING',
  PONG:             'PONG',

  // Model update from UI (extension → bridge)
  MODEL_UPDATED:    'MODEL_UPDATED',     // { activeModel?, extendedThinking? }
};

// ─── Protocol v2 Validation ─────────────────────────────────────────────────────

const PROTOCOL_VERSION = 2;

// ─── Monotonic Fencing Token ───────────────────────────────────────────────────
// Epoch = per-session value (bumped on every reconnect/refresh).
// Sequence = monotonically increasing per-message counter (wraps at 2^53).
// Reject any envelope with epoch < currentEpoch OR seq <= lastSeq.

let _epochCounter = Date.now();
let _messageSeq = 0;

function resetEpochFence() {
  _epochCounter = Date.now();
  _messageSeq = 0;
}

function getEpochFence() {
  return { epoch: _epochCounter, seq: _messageSeq };
}

function createEpochEnvelope(type, payload = {}) {
  _messageSeq = (_messageSeq + 1) % Number.MAX_SAFE_INTEGER;
  return {
    type,
    payload,
    epoch: _epochCounter,
    seq: _messageSeq,
    ts: Date.now(),
  };
}

function validateEpochEnvelope(env, currentEpoch) {
  if (!env || typeof env !== 'object') {
    return { ok: false, error: 'envelope is not an object' };
  }
  // Only validate epoch if present — messages without epoch (e.g. MODELS_DISCOVERED
  // notifications) pass through. Wire messages carry `sessionEpoch`; internal
  // envelopes use `epoch`. If present, it must be >= currentEpoch.
  const envEpoch = typeof env.sessionEpoch === 'number' ? env.sessionEpoch : env.epoch;
  if (typeof envEpoch === 'number' && envEpoch < currentEpoch) {
    return { ok: false, error: `stale epoch: ${envEpoch} < ${currentEpoch}` };
  }
  return { ok: true };
}

function validateMessageSequence(env, lastSeqMap) {
  if (typeof env.seq !== 'number') return true; // legacy, no seq
  const key = `${env.sessionEpoch ?? env.epoch}`;
  const last = lastSeqMap.get(key) ?? 0;
  if (env.seq <= last) return false;
  lastSeqMap.set(key, env.seq);
  return true;
}

/**
 * Validate protocol v2 message structure.
 * Returns { ok:true } or { ok:false, error:string }.
 */
function validateMessage(type, payload) {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, error: `invalid payload for ${type}: not an object` };
  }

  switch (type) {
    case ProtocolV2.SESSION_READY:
      if (typeof payload.sessionEpoch !== 'number' && typeof payload.sessionEpoch !== 'string') {
        return { ok: false, error: 'SESSION_READY requires sessionEpoch' };
      }
      break;

    case ProtocolV2.MODELS_DISCOVERED:
      if (!Array.isArray(payload.models)) {
        return { ok: false, error: 'MODELS_DISCOVERED requires models array' };
      }
      if (payload.models.some(m => !m || typeof m !== 'object' || !m.id)) {
        return { ok: false, error: 'MODELS_DISCOVERED: each model must have an id' };
      }
      break;

    case ProtocolV2.STREAM_CHUNK:
      if (typeof payload.chunk !== 'string' && !Array.isArray(payload.parts)) {
        return { ok: false, error: 'STREAM_CHUNK requires chunk string or parts array' };
      }
      break;

    case ProtocolV2.MODEL_READY:
      if (!payload.requestId || typeof payload.model !== 'string') {
        return { ok: false, error: 'MODEL_READY requires requestId and model' };
      }
      break;

    case ProtocolV2.STREAM_DONE:
    case ProtocolV2.STREAM_ERROR:
      if (!payload.requestId) {
        return { ok: false, error: `${type} requires requestId` };
      }
      break;

    case ProtocolV2.EXECUTE_REQUEST:
      if (!payload.requestId || !payload.payload) {
        return { ok: false, error: 'EXECUTE_REQUEST requires requestId and payload' };
      }
      if (!payload.payload.f_req) {
        return { ok: false, error: 'EXECUTE_REQUEST payload requires f_req' };
      }
      break;

    case ProtocolV2.CANCEL_REQUEST:
      if (!payload.requestId) {
        return { ok: false, error: 'CANCEL_REQUEST requires requestId' };
      }
      break;
  }

  return { ok: true };
}

// ─── ProtocolDecoder (encode/decode Gemini RPC) ──────────────────────────────────
// Mirror ของ Gemini Web Bridge's ProtocolDecoder — ใช้ same encode/decode logic

export class ProtocolDecoder {
  /**
   * Encode messages into Gemini Web RPC f.req format.
   * โครงสร้างเดียวกับ Gemini Web Bridge — ใช้ send ไปยัง de.aipass.net ผ่าน page.js
   */
  static encodeRequest(messages, state = {}, model = '') {
    const combinedPrompt = messages.map(m => JSON.stringify(m)).join('\n');
    const reqArray = [
      [combinedPrompt, 0, null, null, null, null, 0],
      ['en'],
      [state.conversationId || '', state.responseId || '', state.choiceId || '', null, null, []],
      null, null, null, [1], 0, [], [], 1, 0
    ];
    return JSON.stringify([null, JSON.stringify(reqArray)]);
  }

  /**
   * Decode chunk จาก Gemini RPC response.
   * ดึง delta text + conversation state ออกมา
   */
  static decodeChunk(rawChunk) {
    let clean = String(rawChunk ?? '').trim();
    if (clean.startsWith(')]}\'')) {
      clean = clean.substring(4).trim();
    }

    let deltaText = '';
    let stateUpdate = {};

    const lines = clean.split('\n');
    for (const line of lines) {
      if (!line.trim() || /^\d+$/.test(line.trim())) continue;
      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item[0] === 'wrb.fr' && item[2]) {
              const innerData = JSON.parse(item[2]);
              if (innerData[4] && innerData[4][0] && innerData[4][0][1]) {
                const textChunk = innerData[4][0][1][0];
                if (typeof textChunk === 'string') deltaText = textChunk;
              }
              if (innerData[1]) {
                stateUpdate.conversationId = innerData[1][0];
                stateUpdate.responseId = innerData[1][1];
              }
              if (innerData[4] && innerData[4][0] && innerData[4][0][0]) {
                stateUpdate.choiceId = innerData[4][0][0];
              }
            }
          }
        }
      } catch { /* ignore incomplete chunks */ }
    }

    return { deltaText, stateUpdate };
  }
}

// ─── Re-exports ──────────────────────────────────────────────────────────────────

export {
  ProtocolV2,
  PROTOCOL_VERSION,
  validateMessage,
  resetEpochFence,
  getEpochFence,
  createEpochEnvelope,
  validateEpochEnvelope,
  validateMessageSequence,
};
