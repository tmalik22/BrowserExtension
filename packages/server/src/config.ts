/**
 * Configuration: .env (API keys, server options), models.json (model profiles), and persisted
 * settings/token under data/.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { DEFAULT_CONFIRM, DEFAULT_SETTINGS, registerSecret, type ApiKeyInfo, type ConfirmCategory, type ConfirmSettings, type PolicySettings, type ProfileInfo } from '@ba/shared';
import type { ModelProfile } from './providers/types.ts';

/** Set to true by the release bundle (scripts/build-server.ts), where everything sits next to server.mjs. */
declare const __BA_BUNDLE__: boolean | undefined;

/** Folder holding .env, models.json and data/: the repo root, or the bundle's own folder. */
export const ROOT =
  typeof __BA_BUNDLE__ !== 'undefined' && __BA_BUNDLE__
    ? path.dirname(fileURLToPath(import.meta.url))
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function loadEnv(): void {
  dotenv.config({ path: path.join(ROOT, '.env'), quiet: true } as never);
}

export interface ServerConfig {
  host: string;
  port: number;
  token: string;
  dataDir: string;
  /** Allowed chrome-extension:// IDs for WebSocket origins (empty = any extension). */
  extensionIds: string[];

  profiles: ModelProfile[];
  defaultProfileId: string;
  /** Extra operator instructions appended to the system prompt. */
  extraSystemPrompt?: string;
  /** The models.json the profiles came from (profile model changes are written back here). */
  modelsFile?: string;
}

const PROFILE_DEFAULTS: Partial<ModelProfile> = { vision: true, toolMode: 'native', toolSet: 'full' };

export function loadProfiles(file?: string): { profiles: ModelProfile[]; defaultProfileId: string; modelsFile: string } {
  const candidates = file ? [file] : [path.join(ROOT, 'models.json'), path.join(ROOT, 'models.example.json')];
  const found = candidates.find((f) => fs.existsSync(f));
  if (!found) throw new Error(`No model profiles found (looked for ${candidates.join(', ')}).`);
  const raw = JSON.parse(fs.readFileSync(found, 'utf8')) as { default?: string; profiles: Partial<ModelProfile>[] };
  const profiles: ModelProfile[] = [];
  const seen = new Set<string>();
  for (const p of raw.profiles ?? []) {
    if (!p.id || !p.provider || !p.model) throw new Error(`${found}: every profile needs id, provider and model (got ${JSON.stringify(p)}).`);
    if (seen.has(p.id)) throw new Error(`${found}: duplicate profile id "${p.id}".`);
    if (!['anthropic', 'openai', 'mock'].includes(p.provider)) throw new Error(`${found}: profile "${p.id}" has unknown provider "${p.provider}".`);
    seen.add(p.id);
    profiles.push({ ...PROFILE_DEFAULTS, label: p.id, ...p } as ModelProfile);
  }
  // Always offer the mock provider so the extension works without keys.
  if (!seen.has('mock')) profiles.push({ id: 'mock', label: 'Mock (no model)', provider: 'mock', model: 'mock', vision: false, script: 'echo' });
  const envDefault = process.env.AGENT_DEFAULT_PROFILE;
  // Prefer the configured default when it is usable; otherwise the first usable real model.
  const usable = (id: string | undefined) => !!id && profiles.some((p) => p.id === id && profileAvailability(p).available);
  const defaultProfileId = [envDefault, raw.default].find(usable) ?? firstAvailable(profiles)?.id ?? [envDefault, raw.default].find((d) => d && seen.has(d)) ?? profiles[0].id;
  return { profiles, defaultProfileId, modelsFile: found };
}

/** Change one profile's model id in memory and in its models.json. */
export function setProfileModel(config: ServerConfig, profileId: string, model: string): ModelProfile {
  const m = model.trim();
  if (!m || m.length > 200 || /[\s\u0000-\u001f]/.test(m)) throw new Error('That is not a valid model id.');
  const p = config.profiles.find((x) => x.id === profileId);
  if (!p) throw new Error(`Unknown model profile "${profileId}".`);
  p.model = m;
  if (config.modelsFile && path.basename(config.modelsFile) === 'models.json' && fs.existsSync(config.modelsFile)) {
    const raw = JSON.parse(fs.readFileSync(config.modelsFile, 'utf8'));
    const rp = (raw.profiles ?? []).find((x: { id?: string }) => x.id === profileId);
    if (rp) {
      rp.model = m;
      fs.writeFileSync(config.modelsFile, JSON.stringify(raw, null, 2) + '\n');
    }
  }
  return p;
}

export function resolveApiKey(p: ModelProfile): string | undefined {
  const key = resolveApiKeyRaw(p);
  registerSecret(key);
  return key;
}

function resolveApiKeyRaw(p: ModelProfile): string | undefined {
  if (p.apiKey) return p.apiKey;
  if (p.apiKeyFile) {
    // Read on demand so a rotated key file is picked up without restarting.
    try {
      return fs.readFileSync(p.apiKeyFile, 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }
  if (p.apiKeyEnv) return process.env[p.apiKeyEnv]?.trim() || undefined;
  return undefined;
}

export function profileAvailability(p: ModelProfile): { available: boolean; reason?: string } {
  if (p.provider === 'mock') return { available: true };
  if (p.apiKeyFile && !resolveApiKey(p)) return { available: false, reason: `Cannot read the key file ${p.apiKeyFile}` };
  if (p.apiKeyEnv && !resolveApiKey(p)) return { available: false, reason: `Add your ${keyLabel(p.apiKeyEnv)} key in Settings → API keys` };
  if (p.provider === 'anthropic' && !resolveApiKey(p)) return { available: false, reason: 'No API key configured' };
  return { available: true };
}

// API keys -------------------------------------------------------------------------------------

const KEY_LABELS: Record<string, string> = {
  NANOGPT_API_KEY: 'NanoGPT',
  ARK_API_KEY: 'Volcano Ark (coding plan)',
  NVIDIA_API_KEY: 'NVIDIA NIM',
  ANTHROPIC_API_KEY: 'Anthropic',
  OPENAI_API_KEY: 'OpenAI',
  GEMINI_API_KEY: 'Google Gemini',
  OPENROUTER_API_KEY: 'OpenRouter',
  GROQ_API_KEY: 'Groq',
  XAI_API_KEY: 'xAI',
  DEEPSEEK_API_KEY: 'DeepSeek',
  MISTRAL_API_KEY: 'Mistral',
};

export function keyLabel(name: string): string {
  return KEY_LABELS[name] ?? name.replace(/_API_KEY$/, '').replace(/_/g, ' ');
}

/**
 * Provider keys pasted into the side panel. Saved to data/keys.json and applied to process.env,
 * so a saved key takes precedence over .env. Only names that a model profile actually uses can
 * be set, and keys are never sent back to the extension.
 */
export class KeyStore {
  private file: string;
  private saved: Record<string, string> = {};
  /** What process.env had before a saved key replaced it (restored on remove). */
  private original = new Map<string, string | undefined>();

  constructor(
    dataDir: string,
    private profiles: () => ModelProfile[],
    /** Extra key names to offer (providers with a live model list). */
    private extraNames: () => string[] = () => [],
    /** Live model list status per key name. */
    private catalogStatus: () => { keyEnv: string; models: number; updatedAt?: number; error?: string }[] = () => [],
  ) {
    this.file = path.join(dataDir, 'keys.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(raw ?? {})) if (typeof v === 'string' && v.trim()) this.saved[k] = v.trim();
    } catch {
      /* no saved keys */
    }
    for (const [k, v] of Object.entries(this.saved)) {
      registerSecret(v);
      this.apply(k, v);
    }
  }

  /** Key names used by the configured profiles, in profile order. */
  names(): string[] {
    return [...new Set([...this.profiles().map((p) => p.apiKeyEnv).filter((n): n is string => !!n), ...this.extraNames()])];
  }

  set(name: string, key: string): void {
    if (!this.names().includes(name)) throw new Error(`No model uses the key "${name}".`);
    const k = key.trim();
    if (/\s/.test(k)) throw new Error('The key has spaces or line breaks in it. Copy just the key.');
    if (k.length > 500) throw new Error('That is too long to be an API key.');
    if (k) {
      registerSecret(k);
      this.saved[name] = k;
      this.apply(name, k);
    } else {
      delete this.saved[name];
      if (this.original.has(name)) {
        const o = this.original.get(name);
        if (o === undefined) delete process.env[name];
        else process.env[name] = o;
        this.original.delete(name);
      }
    }
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    } catch {
      /* read-only data dir (tests) */
    }
  }

  info(): ApiKeyInfo[] {
    return this.names().map((name) => {
      const v = process.env[name]?.trim();
      return {
        name,
        label: keyLabel(name),
        set: !!v,
        source: this.saved[name] ? 'panel' : v ? 'env' : undefined,
        hint: v && v.length >= 12 ? v.slice(-4) : undefined,
        // Models listed by hand; the live list is summarised separately (it can be hundreds).
        usedBy: this.profiles().filter((p) => p.apiKeyEnv === name && !p.catalog).map((p) => p.label),
        ...(() => {
          const c = this.catalogStatus().find((x) => x.keyEnv === name);
          return c ? { catalogModels: c.models, catalogUpdatedAt: c.updatedAt, catalogError: c.error } : {};
        })(),
      };
    });
  }

  private apply(name: string, key: string): void {
    if (!this.original.has(name)) this.original.set(name, process.env[name]);
    process.env[name] = key;
  }
}

function firstAvailable(profiles: ModelProfile[]): ModelProfile | undefined {
  return profiles.find((p) => p.provider !== 'mock' && profileAvailability(p).available);
}

const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

/** Which picker heading a profile belongs under. */
export function profileGroup(p: ModelProfile): string {
  if (p.group) return p.group;
  if (p.provider === 'mock') return 'Testing';
  if (p.detected || (p.baseURL && LOCAL_URL.test(p.baseURL))) return 'Local';
  if (p.provider === 'anthropic') return 'Anthropic';
  if (p.apiKeyEnv) return keyLabel(p.apiKeyEnv);
  return 'Custom';
}

export function profileInfo(p: ModelProfile): ProfileInfo {
  const a = profileAvailability(p);
  const source = p.provider === 'mock' ? 'test' : p.catalog ? 'catalog' : p.detected ? 'local' : 'config';
  return { id: p.id, label: p.label, provider: p.provider, model: p.model, vision: p.vision, available: a.available, unavailableReason: a.reason, group: profileGroup(p), source, ...(p.captchaProtocol ? { captchaSolver: true } : {}) };
}

export function loadOrCreateToken(dataDir: string): string {
  if (process.env.AGENT_TOKEN?.trim()) return process.env.AGENT_TOKEN.trim();
  const f = path.join(dataDir, 'token.txt');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const t = crypto.randomBytes(18).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(f, t + '\n', { mode: 0o600 });
  return t;
}

/**
 * Make the data folder (API keys, pairing secrets, saved chats and their screenshots) private to
 * the user running the server. On Windows the file modes used elsewhere do nothing, and a folder
 * outside the user profile is readable by every account on the machine unless its access list
 * says otherwise: give it the access list a user-profile folder has (the user, SYSTEM and
 * Administrators), which everything inside it then inherits. Best effort: a failure leaves the
 * folder as it was.
 */
export function protectDataDir(dir: string): void {
  try {
    if (process.platform !== 'win32') {
      fs.chmodSync(dir, 0o700);
      return;
    }
    const icacls = (...args: string[]) => execFileSync('icacls', [dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
    // Already done on an earlier start: nothing on the folder is inherited from its parent.
    if (!/\(I\)/.test(icacls())) return;
    const user = `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ''}${os.userInfo().username}`;
    // Add the explicit entries first, so the folder stays usable if the second step fails.
    icacls('/grant:r', `${user}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F');
    icacls('/inheritance:r');
  } catch {
    /* best effort */
  }
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  loadEnv();
  const dataDir = overrides.dataDir ?? process.env.AGENT_DATA_DIR ?? path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  protectDataDir(dataDir);
  const { profiles, defaultProfileId, modelsFile } = overrides.profiles
    ? { profiles: overrides.profiles, defaultProfileId: overrides.defaultProfileId ?? overrides.profiles[0].id, modelsFile: undefined }
    : loadProfiles(process.env.AGENT_MODELS_FILE);
  return {
    host: process.env.AGENT_HOST ?? '127.0.0.1',
    port: Number(process.env.AGENT_PORT ?? 7878),
    token: overrides.token ?? loadOrCreateToken(dataDir),
    dataDir,
    extensionIds: (process.env.AGENT_EXTENSION_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    extraSystemPrompt: process.env.AGENT_EXTRA_INSTRUCTIONS,
    ...overrides,
    profiles,
    modelsFile: overrides.modelsFile ?? modelsFile,
    defaultProfileId: overrides.defaultProfileId ?? defaultProfileId,
  };
}

// Settings persistence --------------------------------------------------------------------------

export class SettingsStore {
  private file: string;
  private value: PolicySettings;

  constructor(dataDir: string, initial?: Partial<PolicySettings>) {
    this.file = path.join(dataDir, 'settings.json');
    let stored: Partial<PolicySettings> = {};
    if (!initial && fs.existsSync(this.file)) {
      try {
        stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch {
        stored = {};
      }
    }
    // `confirm` comes only from what was stored or passed in, so an old settings file with
    // confirmRiskyClicks: false is migrated instead of being overridden by the defaults.
    const merged = { ...DEFAULT_SETTINGS, ...stored, ...(initial ?? {}) };
    merged.confirm = (initial?.confirm ?? stored.confirm) as ConfirmSettings;
    this.value = sanitizeSettings(merged);
    if (!this.value.uploadDir) this.value.uploadDir = path.join(dataDir, 'uploads');
  }

  get(): PolicySettings {
    return this.value;
  }

  update(patch: Partial<PolicySettings>): PolicySettings {
    const confirm: ConfirmSettings = { ...this.value.confirm, ...(patch.confirm ?? {}) };
    // Older clients send the single "risky clicks" switch.
    if (patch.confirm === undefined && typeof patch.confirmRiskyClicks === 'boolean') {
      for (const id of LEGACY_RISKY) confirm[id] = patch.confirmRiskyClicks;
    }
    this.value = sanitizeSettings({
      ...this.value,
      ...patch,
      // Where file_upload may read from is set on this machine only (AGENT_DATA_DIR), never by a client.
      uploadDir: this.value.uploadDir,
      enableOptional: { ...this.value.enableOptional, ...(patch.enableOptional ?? {}) },
      confirm,
    });
    this.save();
    return this.value;
  }

  allowSite(site: string): void {
    if (!this.value.allowedSites.includes(site)) this.update({ allowedSites: [...this.value.allowedSites, site] });
  }

  private save(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.value, null, 2));
    } catch {
      /* data dir may be read-only in tests */
    }
  }
}

/** Categories the old "Ask before risky clicks" switch covered (everything except credentials). */
const LEGACY_RISKY: ConfirmCategory[] = ['payments', 'messages', 'deletions', 'accountChanges', 'agreements', 'forms', 'dialogs', 'uninspectable'];

export function sanitizeConfirm(confirm: unknown, legacyRisky?: boolean): ConfirmSettings {
  const out: ConfirmSettings = { ...DEFAULT_CONFIRM };
  if (confirm && typeof confirm === 'object') {
    for (const id of Object.keys(DEFAULT_CONFIRM) as ConfirmCategory[]) {
      const v = (confirm as Record<string, unknown>)[id];
      if (typeof v === 'boolean') out[id] = v;
    }
  } else if (legacyRisky === false) {
    for (const id of LEGACY_RISKY) out[id] = false;
  }
  return out;
}

export function sanitizeSettings(s: Omit<PolicySettings, 'confirm'> & { confirm?: unknown }): PolicySettings {
  const list = (v: unknown) =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter(Boolean))] : [];
  return {
    permissionMode: ['ask', 'auto', 'yolo'].includes(s.permissionMode) ? s.permissionMode : 'ask',
    allowedSites: list(s.allowedSites),
    blockedSites: list(s.blockedSites),
    allowPrivateNetworks: !!s.allowPrivateNetworks,
    enableOptional: {
      javascript_exec: !!s.enableOptional?.javascript_exec,
      file_upload: !!s.enableOptional?.file_upload,
      read_console: !!s.enableOptional?.read_console,
      read_network: !!s.enableOptional?.read_network,
    },
    uploadDir: typeof s.uploadDir === 'string' && s.uploadDir ? s.uploadDir : undefined,
    maxSteps: Math.max(1, Math.min(500, Math.floor(Number(s.maxSteps) || DEFAULT_SETTINGS.maxSteps))),
    autoScreenshot: !!s.autoScreenshot,
    lockUserInput: !!s.lockUserInput,
    confirm: sanitizeConfirm(s.confirm, s.confirmRiskyClicks),
    captchaHelperProfileId: typeof s.captchaHelperProfileId === 'string' && s.captchaHelperProfileId.trim() ? s.captchaHelperProfileId.trim() : undefined,
  };
}
