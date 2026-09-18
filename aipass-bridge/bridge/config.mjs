// Unified configuration loading for the aipass-bridge, shared conceptually
// with gemini-web-bridge (same precedence policy, same failure semantics).
//
// Precedence (highest wins):
//   1. Doppler  — secrets fetched from the Doppler project (`doppler secrets
//                 download --no-file --format env`), or already injected into
//                 process.env by `doppler run`.
//   2. Cloudflare — non-secret deployment vars declared in the Worker's
//                 wrangler.toml `[vars]` block (secret VALUES are unreadable
//                 by design; those live only as Worker bindings).
//   3. .env     — a local dotenv file (never overrides layers above).
//   4. schema defaults.
//
// The loader never throws on missing tooling: if Doppler is not installed or
// not configured for this machine, the layer is silently empty and the next
// layer applies. A missing value with no default stays `undefined` so callers
// can fail fast on genuinely required secrets (fail-fast, never fabricate).

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';

function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

// Layer 1: Doppler. Cached per project/config so repeated lookups are free.
let dopplerCache = null;
async function dopplerSecrets() {
  if (dopplerCache) return dopplerCache;
  dopplerCache = {};
  const project = process.env.DOPPLER_PROJECT;
  const config = process.env.DOPPLER_CONFIG;
  if (!project || !config) return dopplerCache;
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFile('doppler', ['secrets', 'download', '--project', project,
        '--config', config, '--no-file', '--format', 'env'],
        { timeout: 10_000, encoding: 'utf8' }, (err, stdout) =>
        err ? reject(err) : resolve({ stdout }));
    });
    dopplerCache = parseEnvText(stdout);
  } catch {
    // No Doppler CLI or not logged in — fall through to the next layer.
  }
  return dopplerCache;
}

// Layer 2: Cloudflare deployment vars (wrangler.toml [vars]; non-secret only).
export function parseWranglerVars(tomlText) {
  const out = {};
  let inVars = false;
  for (const rawLine of String(tomlText ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) { inVars = line === '[vars]'; continue; }
    if (!inVars) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

// Layer 3: local .env (highest allowed path is given by the caller).
function parseDotenv(text) {
  return parseEnvText(text);
}

function coerce(value, type) {
  if (value === undefined || value === null || value === '') return undefined;
  if (type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === 'boolean') {
    if (value === true) return true;
    if (value === false) return false;
    const v = String(value).toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    return undefined;
  }
  return String(value);
}

// Pure resolution for one key — exported for unit tests. Layers are tried in
// precedence order; an uncoercible value (e.g. "abc" for a number) falls
// through to the next layer instead of poisoning the config.
export async function resolveValue(key, spec, context) {
  const { doppler, cloudflare, dotenv, env } = context;
  const envName = spec?.env ?? key;
  for (const raw of [doppler[envName], cloudflare[envName], env?.[envName], dotenv[envName]]) {
    const value = coerce(raw, spec?.type);
    if (value !== undefined) return value;
  }
  return spec?.default;
}

/**
 * Build a resolved config snapshot from a schema of
 * { CONFIG_KEY: { env: 'ENV_NAME', type: 'string'|'number'|'boolean', default } }.
 * @param {object} schema
 * @param {object} [opts]
 * @param {string} [opts.root]         project root containing cloudflare/wrangler.toml
 * @param {string} [opts.dotenvPath]   explicit .env file path
 * @param {object}   [opts.inject]     test seam: pre-resolved layer values
 */
export async function loadConfig(schema, opts = {}) {
  const inject = opts.inject ?? {};
  const doppler = inject.doppler ?? await dopplerSecrets();
  let cloudflare = inject.cloudflare;
  if (!cloudflare && opts.root) {
    try {
      cloudflare = parseWranglerVars(
        await readFile(path.join(opts.root, 'cloudflare', 'wrangler.toml'), 'utf8'));
    } catch { cloudflare = {}; }
  }
  cloudflare ??= {};
  let dotenv = inject.dotenv;
  if (!dotenv) {
    const dotenvFile = opts.dotenvPath ?? path.join(opts.root ?? process.cwd(), '.env');
    try {
      dotenv = parseDotenv(await readFile(dotenvFile, 'utf8'));
    } catch { dotenv = {}; }
  }
  dotenv ??= {};

  const resolved = {};
  for (const [key, spec] of Object.entries(schema)) {
    resolved[key] = await resolveValue(key, spec, {
      doppler, cloudflare, dotenv, env: process.env,
    });
  }
  return resolved;
}
