/**
 * Agent server: WebSocket hub for browser extensions + a small authenticated HTTP API (CLI, evals,
 * automation). Runs sessions (agent loops) and relays their events to the extension's side panel.
 */
import { GpuMonitor, type GpuMonitorOptions } from './gpu.ts';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  newId,
  type AgentEvent,
  type ApprovalDecision,
  type ChatInfo,
  type ClientFrame,
  type PolicySettings,
  type RpcMethod,
  type ServerFrame,
} from '@ba/shared';
import { Session, type ApprovalRequest, type BrowserLink, type SessionHost } from './agent/session.ts';
import { KeyStore, SettingsStore, profileAvailability, profileInfo, setProfileModel, type ServerConfig } from './config.ts';
import { testProfile } from './model-test.ts';
import { createProvider } from './providers/index.ts';
import type { ModelProfile, Provider } from './providers/types.ts';
import { TranscriptWriter } from './transcript.ts';
import { ChatHistory } from './history.ts';
import { ModelCatalog, mergeCatalog, type CatalogProvider } from './catalog.ts';
import { detectLocalModels, mergeDetected, type LocalServer } from './local-models.ts';
import { PairedClients, clientProof, newNonce, safeEqualHex, serverProof, startPairingExchange, whoamiProof, type PairPrompter } from './pairing.ts';

export const SERVER_VERSION = '0.3.0';
const RECONNECT_GRACE_MS = 20_000;
const EVENT_BUFFER = 2000;

type Pending = { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout; conn: WebSocket };

class ClientHandle implements BrowserLink {
  conn: WebSocket | null = null;
  lastSeen = Date.now();
  extensionVersion = '';
  userAgent = '';
  /** Which version of the model list this client has (it's only re-sent when it changes). */
  profilesRev = -1;
  private pending = new Map<string, Pending>();
  private waiters: (() => void)[] = [];

  constructor(readonly clientId: string) {}

  attach(ws: WebSocket): void {
    this.conn = ws;
    this.lastSeen = Date.now();
    const w = this.waiters.splice(0);
    w.forEach((f) => f());
  }

  detach(ws: WebSocket): void {
    if (this.conn === ws) this.conn = null;
    for (const [id, p] of this.pending) {
      if (p.conn === ws) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error('Error: The browser connection was lost while this action was running; its outcome is unknown. Re-check the page before continuing.'));
      }
    }
  }

  send(frame: ServerFrame): boolean {
    if (!this.conn || this.conn.readyState !== this.conn.OPEN) return false;
    this.conn.send(JSON.stringify(frame));
    return true;
  }

  private waitForConnection(ms: number): Promise<boolean> {
    if (this.conn) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((f) => f !== done);
        resolve(false);
      }, ms);
      const done = () => {
        clearTimeout(t);
        resolve(true);
      };
      this.waiters.push(done);
    });
  }

  async call<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    if (!(await this.waitForConnection(RECONNECT_GRACE_MS)) || !this.conn) {
      throw new Error('Error: The browser extension is not connected.');
    }
    const conn = this.conn;
    const id = newId('rpc');
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Error: The browser did not finish "${String(params.member ?? method)}" within ${Math.round(timeoutMs / 1000)} seconds. The page may be unresponsive.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, conn });
      conn.send(JSON.stringify({ type: 'rpc', id, method: method as RpcMethod, params } satisfies ServerFrame));
    });
  }

  resolveRpc(id: string, result: unknown, error?: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
  }
}

interface SessionEntry {
  session: Session;
  clientId: string;
  events: { seq: number; event: AgentEvent }[];
  seq: number;
  listeners: Set<(seq: number, ev: AgentEvent) => void>;
  autoApprove?: ApprovalDecision;
  /** Saved chat this one carries on from. */
  continuedFrom?: string;
}

interface PendingApproval {
  sessionId: string;
  req: ApprovalRequest;
  resolve(d: ApprovalDecision): void;
}

export interface StartOptions {
  clientId?: string;
  sessionId?: string;
  text: string;
  profileId?: string;
  tabId?: string;
  startUrl?: string;
  autoApprove?: ApprovalDecision;
  /** Start a new chat carrying on from this saved one. */
  continueFrom?: string;
}

export class AgentServer implements SessionHost {
  readonly settingsStore: SettingsStore;
  readonly keyStore: KeyStore;
  readonly transcripts: TranscriptWriter;
  readonly chats: ChatHistory;
  private clients = new Map<string, ClientHandle>();
  private sessions = new Map<string, SessionEntry>();
  private approvals = new Map<string, PendingApproval>();
  private providers = new Map<string, Provider>();
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private heartbeat?: NodeJS.Timeout;
  private profiles: Map<string, ModelProfile>;
  readonly gpu?: GpuMonitor;
  /** Called on POST /api/shutdown (a newly started server asking this one to make way). */
  private onShutdownRequest?: () => void;
  private pairPrompt?: PairPrompter;
  readonly paired: PairedClients;
  /** Model list sources: models.json, local detection, provider catalogs. */
  private configProfiles: ModelProfile[];
  private configDefault: string;
  private detectOpt?: boolean | LocalServer[];
  private detected?: Awaited<ReturnType<typeof detectLocalModels>>;
  readonly catalog?: ModelCatalog;
  private profilesRev = 0;
  private profilesSig = '';
  private modelTimer?: NodeJS.Timeout;
  /** One pairing question at a time in the server window, and not too many per minute. */
  private pairingBusy = false;
  private pairingAttempts: number[] = [];

  constructor(
    readonly config: ServerConfig,
    opts: {
      settings?: Partial<PolicySettings>;
      transcripts?: boolean;
      gpu?: GpuMonitorOptions | false;
      onShutdownRequest?: () => void;
      /** Approves "pair with code" requests (the server window). Without one, pairing needs the token. */
      pairPrompt?: PairPrompter;
      /** Find models in local Ollama / LM Studio (true = default ports). */
      detectLocal?: boolean | LocalServer[];
      /** Fetch live model lists from providers the user has keys for (true = all known providers). */
      catalog?: boolean | CatalogProvider[];
    } = {},
  ) {
    this.onShutdownRequest = opts.onShutdownRequest;
    this.pairPrompt = opts.pairPrompt;
    this.paired = new PairedClients(config.dataDir);
    if (opts.gpu) {
      this.gpu = new GpuMonitor(opts.gpu);
      let last = 0;
      this.gpu.onUpdate = (gpu) => {
        // At most one frame per second even if the source is chattier.
        const now = Date.now();
        if (now - last < 900 && !gpu.alerts.length) return;
        last = now;
        for (const c of this.clients.values()) c.send({ type: 'gpu', gpu });
      };
      this.gpu.onAlert = (a, change) => {
        const stamp = new Date().toLocaleTimeString();
        console.log(change === 'start' ? `[${stamp}] GPU ${a.level === 'critical' ? 'ALERT' : 'warning'}: ${a.message}` : `[${stamp}] GPU ok again (${a.id}).`);
        for (const c of this.clients.values()) c.send({ type: 'gpu', gpu: this.gpu!.status() });
      };
    }
    this.settingsStore = new SettingsStore(config.dataDir, opts.settings);
    this.configProfiles = [...config.profiles];
    this.configDefault = config.defaultProfileId;
    this.detectOpt = opts.detectLocal;
    if (opts.catalog) {
      this.catalog = new ModelCatalog(config.dataDir, (env) => process.env[env]?.trim() || undefined, Array.isArray(opts.catalog) ? opts.catalog : undefined);
    }
    this.keyStore = new KeyStore(
      config.dataDir,
      () => this.config.profiles,
      () => this.catalog?.keyNames() ?? [],
      () => this.catalog?.status() ?? [],
    );
    this.transcripts = new TranscriptWriter(config.dataDir, opts.transcripts ?? true);
    this.chats = new ChatHistory(config.dataDir);
    this.profiles = new Map(config.profiles.map((p) => [p.id, p]));
    this.rebuildProfiles(false); // cached catalogs show up straight away
    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    this.httpServer.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith('/ws')) {
        socket.destroy();
        return;
      }
      const origin = req.headers.origin;
      if (!this.hostAllowed(req.headers.host)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      if (origin && !this.originAllowed(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  /**
   * DNS-rebinding guard: on a loopback bind, only accept requests addressed to this machine
   * (a rebinding page sends its own hostname in Host). AGENT_ALLOWED_HOSTS adds names for remote use.
   */
  private hostAllowed(host: string | undefined): boolean {
    if (!host) return false;
    const h = host.toLowerCase();
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(this.config.host);
    const extra = (process.env.AGENT_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (extra.some((e) => h === e || h.startsWith(`${e}:`))) return true;
    if (!loopback) return true;
    const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
  }

  private originAllowed(origin: string): boolean {
    const m = origin.match(/^chrome-extension:\/\/([a-p]{32})$/);
    if (!m) return false;
    return !this.config.extensionIds.length || this.config.extensionIds.includes(m[1]);
  }

  listen(port = this.config.port, host = this.config.host): Promise<number> {
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(port, host, () => {
        this.heartbeat = setInterval(() => this.ping(), 20_000);
        // Provider model lists go stale: check every 6 hours (each list is re-fetched daily).
        if (this.catalog) this.modelTimer = setInterval(() => void this.refreshModels().catch(() => {}), 6 * 60 * 60 * 1000).unref();
        this.gpu?.start();
        // Warm a configured local CAPTCHA helper alongside the agent server.
        void this.prepareCaptchaHelper();
        const addr = this.httpServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    clearInterval(this.modelTimer);
    this.gpu?.stop();
    for (const e of this.sessions.values()) e.session.stop();
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
    await new Promise<void>((r) => this.httpServer.close(() => r()));
  }

  // SessionHost -------------------------------------------------------------------------------

  settings(): PolicySettings {
    return this.settingsStore.get();
  }

  allowSitePermanently(site: string): void {
    this.settingsStore.allowSite(site);
    this.broadcastState();
  }

  captchaHelper(): { profile: ModelProfile; provider: Provider } | undefined {
    const id = this.settings().captchaHelperProfileId;
    if (!id) return undefined;
    const profile = this.profiles.get(id);
    if (!profile || profile.provider === 'mock' || !profileAvailability(profile).available) return undefined;
    return { profile, provider: this.providerFor(profile) };
  }

  /** Start a local helper's model server if it is down (no-op for cloud profiles). */
  async prepareCaptchaHelper(): Promise<void> {
    const profile = this.captchaHelper()?.profile;
    if (!profile?.startScript || !profile.baseURL) return;
    const health = new URL('/health', profile.baseURL).toString();
    const ok = async () => {
      try {
        return (await fetch(health, { signal: AbortSignal.timeout(1500) })).ok;
      } catch {
        return false;
      }
    };
    if (await ok()) return;
    try {
      // No `detached` on Windows: a detached powershell launches llama-server into a dead
      // console here, so the server never binds. stdio:'ignore' + windowsHide is enough.
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', profile.startScript], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } catch {
      return;
    }
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      if (await ok()) return;
    }
  }

  log(sessionId: string, record: Record<string, unknown>): void {
    this.transcripts.write(sessionId, record);
  }

  emit(sessionId: string, event: AgentEvent): void {
    const e = this.sessions.get(sessionId);
    if (!e) return;
    const seq = ++e.seq;
    // Deltas are not buffered for replay (the final text/thinking events are).
    if (event.type !== 'text_delta' && event.type !== 'thinking_delta') {
      e.events.push({ seq, event });
      if (e.events.length > EVENT_BUFFER) e.events.splice(0, e.events.length - EVENT_BUFFER);
    }
    this.clients.get(e.clientId)?.send({ type: 'agent_event', sessionId, seq, event });
    for (const l of e.listeners) l(seq, event);
    if (event.type === 'status' || event.type === 'session_started') this.broadcastState();
  }

  requestApproval(sessionId: string, req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const entry = this.sessions.get(sessionId);
    const approvalId = newId('ap');
    if (entry?.autoApprove) {
      // Automation (CLI/evals) pre-approved: still leave an audit trail in the event stream.
      this.emit(sessionId, { type: 'approval_request', approvalId, ...req });
      this.emit(sessionId, { type: 'approval_resolved', approvalId, decision: entry.autoApprove });
      return Promise.resolve(entry.autoApprove);
    }
    return new Promise<ApprovalDecision>((resolve) => {
      const timeout = setTimeout(() => finish('deny'), 10 * 60_000);
      const finish = (d: ApprovalDecision) => {
        if (!this.approvals.has(approvalId)) return;
        clearTimeout(timeout);
        this.approvals.delete(approvalId);
        this.emit(sessionId, { type: 'approval_resolved', approvalId, decision: d });
        resolve(d);
      };
      this.approvals.set(approvalId, { sessionId, req, resolve: finish });
      signal.addEventListener('abort', () => finish('deny'), { once: true });
      this.emit(sessionId, { type: 'approval_request', approvalId, ...req });
    });
  }

  resolveApproval(approvalId: string, decision: ApprovalDecision): boolean {
    const a = this.approvals.get(approvalId);
    if (!a) return false;
    a.resolve(decision);
    return true;
  }

  // Sessions ----------------------------------------------------------------------------------

  private providerFor(profile: ModelProfile): Provider {
    let p = this.providers.get(profile.id);
    if (!p) {
      p = createProvider(profile);
      this.providers.set(profile.id, p);
    }
    return p;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id)?.session;
  }

  /** Start a new session or continue an existing one. Returns the session id immediately. */
  startOrContinue(opts: StartOptions): { sessionId: string; done: Promise<void> } {
    let entry = opts.sessionId ? this.sessions.get(opts.sessionId) : undefined;
    if (opts.sessionId && !entry) throw new Error(`Unknown session ${opts.sessionId}.`);
    const profileId = opts.profileId ?? entry?.session.profile.id ?? this.config.defaultProfileId;
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Unknown model profile "${profileId}".`);
    const avail = profileAvailability(profile);
    if (!avail.available) throw new Error(`Model profile "${profile.label}" is unavailable: ${avail.reason}.`);

    if (!entry) {
      const clientId = opts.clientId ?? this.pickClient();
      if (!clientId) throw new Error('No browser extension is connected to the agent server.');
      const client = this.clientHandle(clientId);
      const session = new Session({
        profile,
        provider: this.providerFor(profile),
        link: client,
        host: this,
        tabId: opts.tabId,
        startUrl: opts.startUrl,
        extraSystemPrompt: this.config.extraSystemPrompt,
      });
      let context: string | undefined;
      if (opts.continueFrom) {
        context = this.chats.recap(opts.continueFrom) ?? undefined;
        if (!context) throw new Error("That earlier chat couldn't be found anymore, so it can't be continued. Start a new task instead.");
        session.title = this.chats.titleFor(opts.continueFrom) ?? session.title;
      }
      entry = { session, clientId, events: [], seq: 0, listeners: new Set(), autoApprove: opts.autoApprove, continuedFrom: opts.continueFrom };
      this.sessions.set(session.id, entry);
      if (opts.continueFrom) this.log(session.id, { kind: 'continued_from', sessionId: opts.continueFrom });
      const done = session.send(opts.text, context);
      done.catch(() => {});
      return { sessionId: session.id, done };
    } else if (entry.session.running) {
      // Deliver it to the running agent at its next step.
      entry.session.interject(opts.text);
      return { sessionId: entry.session.id, done: entry.session.settled() };
    } else if (profile.id !== entry.session.profile.id) {
      entry.session.setProvider(profile, this.providerFor(profile));
    }
    const done = entry.session.send(opts.text);
    done.catch(() => {});
    return { sessionId: entry.session.id, done };
  }

  /** Past and current chats for one browser, newest first. */
  listChats(clientId: string, limit = 50): ChatInfo[] {
    const live = new Map([...this.sessions.values()].filter((e) => e.clientId === clientId).map((e) => [e.session.id, e]));
    const folded = new Set([...live.values()].map((e) => e.continuedFrom).filter(Boolean));
    const out: ChatInfo[] = [];
    for (const c of this.chats.list(limit)) {
      if (folded.has(c.sessionId)) continue;
      const e = live.get(c.sessionId);
      live.delete(c.sessionId);
      out.push({
        sessionId: c.sessionId,
        title: e?.session.title ?? c.title,
        profileId: e?.session.profile.id ?? c.profileId,
        startedAt: c.startedAt,
        updatedAt: c.updatedAt,
        messages: c.messages,
        lastReply: c.lastReply,
        live: !!e,
        running: !!e?.session.running,
      });
    }
    // Live chats with nothing saved yet (or saving turned off).
    for (const e of live.values()) {
      if (!e.events.length) continue;
      out.push({ sessionId: e.session.id, title: e.session.title, profileId: e.session.profile.id, startedAt: e.session.createdAt, updatedAt: Date.now(), messages: 0, live: true, running: e.session.running });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  stopSession(id: string): boolean {
    const e = this.sessions.get(id);
    if (!e) return false;
    e.session.stop();
    return true;
  }

  subscribe(sessionId: string, fn: (seq: number, ev: AgentEvent) => void, since = 0): () => void {
    const e = this.sessions.get(sessionId);
    if (!e) throw new Error(`Unknown session ${sessionId}.`);
    for (const x of e.events) if (x.seq > since) fn(x.seq, x.event);
    e.listeners.add(fn);
    return () => e.listeners.delete(fn);
  }

  private pickClient(): string | undefined {
    let best: ClientHandle | undefined;
    for (const c of this.clients.values()) if (c.conn && (!best || c.lastSeen > best.lastSeen)) best = c;
    return best?.clientId;
  }

  private clientHandle(id: string): ClientHandle {
    let c = this.clients.get(id);
    if (!c) {
      c = new ClientHandle(id);
      this.clients.set(id, c);
    }
    return c;
  }

  connectedClients(): { clientId: string; extensionVersion: string; userAgent: string }[] {
    return [...this.clients.values()].filter((c) => c.conn).map((c) => ({ clientId: c.clientId, extensionVersion: c.extensionVersion, userAgent: c.userAgent }));
  }

  private stateFor(clientId?: string): ServerFrame {
    const sessions = [...this.sessions.values()].filter((e) => !clientId || e.clientId === clientId).map((e) => e.session.summary());
    // The model list can be hundreds long: only send it when it changed for this client.
    const c = clientId ? this.clients.get(clientId) : undefined;
    const withProfiles = !c || c.profilesRev !== this.profilesRev;
    if (c) c.profilesRev = this.profilesRev;
    return {
      type: 'state',
      sessions,
      settings: this.settings(),
      ...(withProfiles ? { profiles: this.config.profiles.map(profileInfo), defaultProfileId: this.config.defaultProfileId } : {}),
      apiKeys: this.keyStore.info(),
    };
  }

  // Models -------------------------------------------------------------------------------------

  /** Recompute the model list from models.json, detected local models and provider catalogs. */
  private rebuildProfiles(broadcast = true): void {
    const usable = (p: ModelProfile) => profileAvailability(p).available;
    const base = this.detected
      ? mergeDetected(this.configProfiles, this.configDefault, this.detected, usable)
      : { profiles: this.configProfiles, defaultProfileId: this.configDefault };
    const fromCatalog = this.catalog?.profiles() ?? [];
    const all = mergeCatalog(base.profiles, fromCatalog);
    let def = base.defaultProfileId;
    const cur = all.find((p) => p.id === def);
    if (!cur || cur.provider === 'mock' || !usable(cur)) {
      const pick = pickDefault(fromCatalog.filter(usable));
      if (pick) def = pick.id;
    }
    this.config.profiles = all;
    this.config.defaultProfileId = def;
    this.profiles = new Map(all.map((p) => [p.id, p]));
    // Compare with what clients last received (availability depends on keys, not only the list).
    const sig = JSON.stringify([def, all.map((p) => [p.id, p.model, p.vision, usable(p)])]);
    if (sig !== this.profilesSig) {
      this.profilesSig = sig;
      this.profilesRev++;
    }
    if (broadcast) this.broadcastState();
  }

  /** Re-scan local model servers and (unless catalog: false) refresh stale provider lists. */
  async refreshModels(opts: { catalog?: boolean; force?: boolean } = {}): Promise<void> {
    if (this.detectOpt) this.detected = await detectLocalModels(this.configProfiles, Array.isArray(this.detectOpt) ? this.detectOpt : undefined);
    if (this.catalog && opts.catalog !== false) await this.catalog.refresh({ force: opts.force });
    this.rebuildProfiles();
  }

  /** A key was saved or removed: refresh that provider's list now. */
  private async refreshCatalogFor(keyEnv: string): Promise<void> {
    const p = this.catalog?.providerForKey(keyEnv);
    if (!p || !this.catalog) return;
    await this.catalog.refresh({ force: true, only: [p.id] });
    this.rebuildProfiles();
  }

  catalogStatus() {
    return this.catalog?.status() ?? [];
  }

  private broadcastState(): void {
    for (const c of this.clients.values()) c.send(this.stateFor(c.clientId));
  }

  // WebSocket ---------------------------------------------------------------------------------

  private ping(): void {
    const now = Date.now();
    for (const ws of this.wss.clients) {
      const meta = ws as WebSocket & { lastPong?: number };
      if (meta.lastPong && now - meta.lastPong > 70_000) {
        ws.terminate();
        continue;
      }
      ws.send(JSON.stringify({ type: 'ping', t: now } satisfies ServerFrame));
    }
  }

  private onConnection(ws: WebSocket): void {
    let client: ClientHandle | null = null;
    const meta = ws as WebSocket & { lastPong?: number };
    meta.lastPong = Date.now();
    const helloTimer = setTimeout(() => {
      if (!client) ws.close(4001, 'hello timeout');
    }, 10_000);

    ws.on('message', (data) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      meta.lastPong = Date.now();
      if (!client) {
        const reject = (message: string, code = 4003) => {
          ws.send(JSON.stringify({ type: 'hello_error', message } satisfies ServerFrame));
          ws.close(code, 'auth');
        };
        // Pairing, step 2: the client reveals the key it committed to; now both sides know the code.
        if (pendingReveal) {
          const r = pendingReveal;
          pendingReveal = null;
          const fail = () => {
            // No question was asked yet: free the pairing slot.
            clearTimeout(r.timer);
            this.pairingBusy = false;
            return reject('Invalid pairing request.');
          };
          if (frame.type !== 'pair_reveal') return fail();
          let ex: { secret: string; code: string; confirm: string };
          try {
            ex = r.exchange.reveal(frame.publicKey);
          } catch {
            return fail();
          }
          pendingPair = { ...ex, hello: r.hello, browserConfirmed: false, serverApproved: false, timer: r.timer };
          void this.pairPrompt!({ clientId: r.hello.clientId, code: ex.code, userAgent: r.hello.userAgent })
            .catch(() => false)
            .then((ok) => {
              this.pairingBusy = false;
              if (!pendingPair || ws.readyState !== 1) return; // gone or failed meanwhile
              if (!ok) {
                pendingPair = null;
                return reject('Pairing was declined in the server window.');
              }
              pendingPair.serverApproved = true;
              finishPairing();
            });
          return;
        }
        // Pairing, step 3: the user confirmed matching codes in the side panel.
        if (pendingPair) {
          if (frame.type !== 'pair_confirm' || typeof frame.proof !== 'string' || !safeEqualHex(frame.proof, pendingPair.confirm)) {
            pendingPair = null;
            return reject('Pairing failed: the codes did not match. Start pairing again.');
          }
          pendingPair.browserConfirmed = true;
          finishPairing();
          return;
        }
        // Second step of the mutual handshake.
        if (pendingAuth) {
          const p = pendingAuth;
          pendingAuth = null;
          if (frame.type !== 'auth' || typeof frame.proof !== 'string' || !safeEqualHex(frame.proof, clientProof(p.key, p.serverNonce))) {
            return reject('Authentication failed. Pair this browser again or paste the current pairing token.');
          }
          accept(p.hello);
          return;
        }
        if (frame.type !== 'hello') {
          ws.close(4002, 'expected hello');
          return;
        }
        if (frame.protocol !== PROTOCOL_VERSION) {
          return reject(`Protocol mismatch: extension ${frame.protocol}, server ${PROTOCOL_VERSION}. Update both.`, 4004);
        }
        const clientId = typeof frame.clientId === 'string' && /^[\w-]{1,100}$/.test(frame.clientId) ? frame.clientId : newId('c');
        frame.clientId = clientId;
        if (typeof frame.clientNonce === 'string' && /^[0-9a-f]{32,128}$/.test(frame.clientNonce)) {
          const key = frame.keyType === 'paired' ? this.paired.secretFor(clientId) : this.config.token;
          if (!key) return reject('This browser is no longer paired with this server. Pair it again.');
          const serverNonce = newNonce();
          pendingAuth = { key, serverNonce, hello: frame };
          ws.send(JSON.stringify({ type: 'challenge', serverNonce, proof: serverProof(key, frame.clientNonce) } satisfies ServerFrame));
          return;
        }
        if (typeof frame.pairCommit === 'string') {
          if (!this.pairPrompt) return reject('This server can’t approve pairing here. Paste the pairing token it printed into Settings → Pairing token.');
          const now = Date.now();
          this.pairingAttempts = this.pairingAttempts.filter((t) => now - t < 60_000);
          if (this.pairingAttempts.length >= 5) return reject('Too many pairing attempts. Wait a minute and try again.');
          if (this.pairingBusy) return reject('Another pairing request is waiting in the server window. Try again in a moment.');
          let exchange: ReturnType<typeof startPairingExchange>;
          try {
            exchange = startPairingExchange(frame.pairCommit);
          } catch {
            return reject('Invalid pairing request.');
          }
          this.pairingAttempts.push(now);
          this.pairingBusy = true;
          clearTimeout(helloTimer);
          const timer = setTimeout(() => {
            this.pairingBusy = false;
            ws.close(4001, 'pairing timeout');
          }, 120_000);
          pendingReveal = { exchange, hello: frame, timer };
          ws.send(JSON.stringify({ type: 'pair_pending', publicKey: exchange.serverPub } satisfies ServerFrame));
          return;
        }
        // Scripts and tests that hold the token may still send it directly.
        if (typeof frame.token === 'string' && frame.token && safeEqual(frame.token, this.config.token)) {
          accept(frame);
          return;
        }
        return reject(frame.token ? 'Invalid pairing token. Copy the token printed by the agent server into the extension settings.' : 'This server needs a pairing token.');
      }
      client.lastSeen = Date.now();
      this.onFrame(client, frame);
    });
    let pendingAuth: { key: string; serverNonce: string; hello: Extract<ClientFrame, { type: 'hello' }> } | null = null;
    let pendingReveal: { exchange: ReturnType<typeof startPairingExchange>; hello: Extract<ClientFrame, { type: 'hello' }>; timer: NodeJS.Timeout } | null = null;
    let pendingPair:
      | { secret: string; confirm: string; hello: Extract<ClientFrame, { type: 'hello' }>; browserConfirmed: boolean; serverApproved: boolean; timer: NodeJS.Timeout }
      | null = null;
    /** Pair once BOTH the side panel (matching codes) and the server window agreed. */
    const finishPairing = () => {
      if (!pendingPair?.browserConfirmed || !pendingPair.serverApproved) return;
      const p = pendingPair;
      pendingPair = null;
      clearTimeout(p.timer);
      this.paired.store(p.hello.clientId, p.secret, p.hello.userAgent);
      accept(p.hello);
    };
    const accept = (frame: Extract<ClientFrame, { type: 'hello' }>) => {
      clearTimeout(helloTimer);
      client = this.clientHandle(String(frame.clientId || newId('c')));
      if (client.conn && client.conn !== ws) client.conn.close(4005, 'replaced');
      client.attach(ws);
      client.extensionVersion = frame.extensionVersion;
      client.userAgent = frame.userAgent;
      client.profilesRev = this.profilesRev;
      client.send({
        type: 'hello_ok',
        serverVersion: SERVER_VERSION,
        protocol: PROTOCOL_VERSION,
        profiles: this.config.profiles.map(profileInfo),
        defaultProfileId: this.config.defaultProfileId,
        settings: this.settings(),
      });
      client.send(this.stateFor(client.clientId));
      if (this.gpu) client.send({ type: 'gpu', gpu: this.gpu.status() });
    };
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (pendingPair) clearTimeout(pendingPair.timer);
      if (pendingReveal) {
        // Gave up before revealing: no question was asked, free the slot.
        clearTimeout(pendingReveal.timer);
        this.pairingBusy = false;
      }
      pendingPair = null;
      pendingReveal = null;
      client?.detach(ws);
    });
    ws.on('error', () => {});
  }

  private respond(client: ClientHandle, requestId: string, ok: boolean, data?: unknown, error?: string): void {
    client.send({ type: 'response', requestId, ok, data, error });
  }

  private onFrame(client: ClientHandle, frame: ClientFrame): void {
    switch (frame.type) {
      case 'pong':
        return;
      case 'rpc_result':
        client.resolveRpc(frame.id, frame.result, frame.error);
        return;
      case 'send_message':
        try {
          const existing = frame.sessionId ? this.sessions.get(frame.sessionId) : undefined;
          if (existing && existing.clientId !== client.clientId) throw new Error('That session belongs to another browser.');
          const { sessionId } = this.startOrContinue({
            clientId: client.clientId,
            sessionId: frame.sessionId,
            text: frame.text,
            profileId: frame.profileId,
            tabId: frame.tabId,
            continueFrom: frame.sessionId ? undefined : frame.continueFrom,
          });
          this.respond(client, frame.requestId, true, { sessionId });
        } catch (e) {
          this.respond(client, frame.requestId, false, undefined, (e as Error).message);
        }
        return;
      case 'stop': {
        const e = this.sessions.get(frame.sessionId);
        if (e && e.clientId === client.clientId) e.session.stop();
        return;
      }
      case 'approval_response': {
        const a = this.approvals.get(frame.approvalId);
        const valid = frame.decision === 'allow_once' || frame.decision === 'allow_site' || frame.decision === 'deny';
        if (valid && a && this.sessions.get(a.sessionId)?.clientId === client.clientId) this.resolveApproval(frame.approvalId, frame.decision);
        return;
      }
      case 'update_settings': {
        try {
          this.settingsStore.update(frame.settings);
          this.respond(client, frame.requestId, true, this.settings());
          this.broadcastState();
        } catch (e) {
          this.respond(client, frame.requestId, false, undefined, (e as Error).message);
        }
        return;
      }
      case 'get_state':
        this.respond(client, frame.requestId, true, this.stateFor(client.clientId));
        return;
      case 'set_api_key':
        try {
          this.keyStore.set(String(frame.name), String(frame.key ?? ''));
          this.respond(client, frame.requestId, true, this.keyStore.info());
          this.rebuildProfiles(); // models needing this key become (un)available
          void this.refreshCatalogFor(String(frame.name));
        } catch (e) {
          this.respond(client, frame.requestId, false, undefined, (e as Error).message);
        }
        return;
      case 'test_api_key': {
        const name = String(frame.name);
        // Models listed by hand get one small test request each; a live model list is checked by
        // fetching it (which also proves the key works), not by calling hundreds of models.
        const profiles = this.config.profiles.filter((p) => p.apiKeyEnv === name && !p.catalog);
        const cat = this.catalog?.providerForKey(name);
        if (!profiles.length && !cat) {
          this.respond(client, frame.requestId, false, undefined, `No model uses the key "${name}".`);
          return;
        }
        const listCheck = async () => {
          if (!cat || !this.catalog) return [];
          await this.refreshCatalogFor(name);
          const st = this.catalog.status().find((s) => s.keyEnv === name);
          const ok = !!st && !st.error && st.models > 0;
          return [{ profileId: `${cat.id}/*`, label: `${cat.label} model list`, model: '', ok, message: ok ? `The key works: ${st!.models} models are available in the model menu.` : (st?.error ?? 'No models were returned.') }];
        };
        void Promise.all([listCheck(), Promise.all(profiles.map((p) => testProfile(p)))]).then(([list, results]) =>
          this.respond(client, frame.requestId, true, { name, results: [...list, ...results] }),
        );
        return;
      }
      case 'refresh_models':
        void this.refreshModels({ force: true }).then(
          () => this.respond(client, frame.requestId, true, this.keyStore.info()),
          (e) => this.respond(client, frame.requestId, false, undefined, (e as Error).message),
        );
        return;
      case 'set_profile_model':
        try {
          const p = setProfileModel(this.config, String(frame.profileId), String(frame.model ?? ''));
          this.respond(client, frame.requestId, true, { profileId: p.id, model: p.model });
          this.broadcastState();
        } catch (e) {
          this.respond(client, frame.requestId, false, undefined, (e as Error).message);
        }
        return;
      case 'get_history': {
        const e = this.sessions.get(frame.sessionId);
        if (e && e.clientId !== client.clientId) {
          this.respond(client, frame.requestId, false, undefined, 'Unknown session');
          return;
        }
        if (!e) {
          // Not in memory (e.g. the server restarted): redraw it from its saved transcript.
          const saved = this.chats.replay(String(frame.sessionId));
          if (!saved) this.respond(client, frame.requestId, false, undefined, 'Unknown session');
          else this.respond(client, frame.requestId, true, { events: saved.map((event) => ({ seq: 0, event })), pendingApprovals: [], status: 'idle', archived: true });
          return;
        }
        const pending = [...this.approvals.entries()].filter(([, a]) => a.sessionId === frame.sessionId).map(([id]) => id);
        const before = e.continuedFrom ? this.chats.replayBefore(e.continuedFrom).map((event) => ({ seq: 0, event })) : [];
        this.respond(client, frame.requestId, true, { events: [...before, ...e.events], pendingApprovals: pending, status: e.session.status, archived: false });
        return;
      }
      case 'list_chats':
        this.respond(client, frame.requestId, true, this.listChats(client.clientId, Math.min(200, Math.max(1, Number(frame.limit) || 50))));
        return;
    }
  }

  // HTTP API ----------------------------------------------------------------------------------

  private authorized(req: http.IncomingMessage): boolean {
    const h = req.headers.authorization ?? '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    return safeEqual(t, this.config.token);
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    // DNS rebinding: refuse requests addressed to any other hostname.
    if (!this.hostAllowed(req.headers.host)) return send(403, { error: 'Forbidden host.' });
    // Browsers must not be able to drive the API cross-origin: no CORS headers, JSON bodies only.
    if (url.pathname === '/health') return send(200, { ok: true, version: SERVER_VERSION, clients: this.connectedClients().length });
    // Lets a newly started server check this really is a Browser Agent server holding the same
    // token before sending it (domain-separated, so it can't answer extension handshakes).
    if (url.pathname === '/whoami') {
      const nonce = url.searchParams.get('nonce') ?? '';
      if (!/^[0-9a-f]{32,128}$/.test(nonce)) return send(400, { error: 'Bad nonce.' });
      return send(200, { proof: whoamiProof(this.config.token, nonce) });
    }
    if (!this.authorized(req)) return send(401, { error: 'Missing or invalid bearer token.' });
    try {
      const parts = url.pathname.split('/').filter(Boolean); // api, sessions, :id, ...
      if (parts[0] !== 'api') return send(404, { error: 'Not found' });
      if (req.method === 'GET' && parts[1] === 'state') {
        return send(200, {
          clients: this.connectedClients(),
          sessions: [...this.sessions.values()].map((e) => e.session.summary()),
          settings: this.settings(),
          profiles: this.config.profiles.map(profileInfo),
          defaultProfileId: this.config.defaultProfileId,
        });
      }
      if (req.method === 'POST' && parts[1] === 'shutdown') {
        if (!this.onShutdownRequest) return send(404, { error: 'Not found' });
        send(200, { ok: true });
        setImmediate(() => this.onShutdownRequest?.());
        return;
      }
      if (req.method === 'GET' && parts[1] === 'gpu') {
        return send(200, this.gpu?.status() ?? { available: false, error: 'GPU monitoring is off.', history: [], alerts: [] });
      }
      if (parts[1] === 'settings' && req.method === 'POST') {
        const body = await readJson(req);
        this.settingsStore.update(body as Partial<PolicySettings>);
        this.broadcastState();
        return send(200, this.settings());
      }
      if (parts[1] === 'sessions' && req.method === 'POST' && parts.length === 2) {
        const body = (await readJson(req)) as Record<string, unknown>;
        if (typeof body.text !== 'string' || !body.text.trim()) return send(400, { error: 'text is required' });
        const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
        // Automation may pre-approve "once" or pre-deny; anything else (including allow_site, which
        // would permanently allow sites) is ignored and approvals go to the user as usual.
        const autoApprove = body.autoApprove === 'allow_once' || body.autoApprove === 'deny' ? body.autoApprove : undefined;
        const { sessionId } = this.startOrContinue({
          text: body.text,
          clientId: str(body.clientId),
          profileId: str(body.profileId),
          tabId: str(body.tabId),
          startUrl: str(body.startUrl),
          continueFrom: str(body.continueFrom),
          autoApprove,
        });
        return send(200, { sessionId });
      }
      if (parts[1] === 'sessions' && parts[2]) {
        const id = parts[2];
        const entry = this.sessions.get(id);
        if (!entry) return send(404, { error: 'Unknown session' });
        if (req.method === 'POST' && parts[3] === 'messages') {
          const body = (await readJson(req)) as { text?: string; profileId?: string };
          if (!body.text) return send(400, { error: 'text is required' });
          this.startOrContinue({ sessionId: id, text: body.text, profileId: body.profileId });
          return send(200, { sessionId: id });
        }
        if (req.method === 'POST' && parts[3] === 'stop') return send(200, { stopped: this.stopSession(id) });
        if (req.method === 'POST' && parts[3] === 'end') {
          await entry.session.end();
          return send(200, { ended: true });
        }
        if (req.method === 'GET' && parts[3] === 'events') return this.sse(req, res, id, Number(url.searchParams.get('since') ?? 0));
        if (req.method === 'GET' && !parts[3]) {
          return send(200, { ...entry.session.summary(), usage: entry.session.usage, events: entry.events });
        }
      }
      if (parts[1] === 'approvals' && parts[2] && req.method === 'POST') {
        const body = (await readJson(req)) as { decision?: ApprovalDecision };
        const d = body.decision;
        if (d !== 'allow_once' && d !== 'allow_site' && d !== 'deny') return send(400, { error: 'decision must be allow_once | allow_site | deny' });
        return send(this.resolveApproval(parts[2], d) ? 200 : 404, { ok: true });
      }
      return send(404, { error: 'Not found' });
    } catch (e) {
      return send(400, { error: (e as Error).message });
    }
  }

  private sse(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string, since: number): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const unsub = this.subscribe(sessionId, (seq, ev) => res.write(`id: ${seq}\ndata: ${JSON.stringify(ev)}\n\n`), since);
    const keep = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(keep);
      unsub();
    });
  }
}

/** A sensible default among live-list models when the configured default can't be used. */
function pickDefault(models: ModelProfile[]): ModelProfile | undefined {
  const prefer = [/claude-.*sonnet/i, /claude-.*opus/i, /^gpt-5(?!.*(nano|mini))/i, /^gpt-4\.1(?!.*(nano|mini))/i, /gemini-.*pro/i, /qwen.*vl/i, /llama-4/i];
  for (const re of prefer) {
    const m = models.find((p) => re.test(p.model) && p.vision);
    if (m) return m;
  }
  return models.find((p) => p.vision) ?? models[0];
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length > 0;
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const ct = req.headers['content-type'] ?? '';
  if (!ct.includes('application/json')) throw new Error('Content-Type must be application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 5 * 1024 * 1024) throw new Error('Body too large');
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

