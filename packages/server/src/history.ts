/**
 * Past chats, read back from the transcripts in data/sessions/<stamp>_<sessionId>/events.jsonl.
 * Lets the side panel list old chats, show them again after a restart, and carry one on in a new
 * chat (the model gets a written summary, since tool inputs and model-internal data aren't saved).
 */
import fs from 'node:fs';
import path from 'node:path';
import { isBrowserMember, summarizeCall, truncate, type AgentEvent, type ChatInfo } from '@ba/shared';

type Rec = Record<string, any>;

const ID_RE = /^[\w-]{1,80}$/;
/** Folder names the transcript writer produces: <UTC timestamp>_<session id>. */
const SAVED_CHAT_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_[\w-]{1,80}$/;
/** Screenshots sent back when replaying a saved chat (the most recent ones). */
const REPLAY_IMAGES = 6;
const MAX_CHAIN = 8;

export interface SavedChat extends Omit<ChatInfo, 'live' | 'running'> {
  dir: string;
  continuedFrom?: string;
  /** The browser (extension client id) that started the chat; absent in chats saved before this was recorded. */
  clientId?: string;
}

export class ChatHistory {
  private cache = new Map<string, { key: string; chat: SavedChat | null }>();

  constructor(private dataDir: string) {}

  private get root(): string {
    return path.join(this.dataDir, 'sessions');
  }

  /** Folder of a saved chat, or undefined. */
  dirOf(sessionId: string): string | undefined {
    if (!ID_RE.test(sessionId)) return undefined;
    let names: string[];
    try {
      names = fs.readdirSync(this.root);
    } catch {
      return undefined;
    }
    const name = names.filter((n) => n.endsWith(`_${sessionId}`)).sort().pop();
    return name ? path.join(this.root, name) : undefined;
  }

  private records(dir: string): Rec[] {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const out: Rec[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a torn last line */
      }
    }
    return out;
  }

  /** Summary of one saved chat (cached until its file changes). */
  read(dir: string): SavedChat | null {
    const file = path.join(dir, 'events.jsonl');
    let key: string;
    try {
      const st = fs.statSync(file);
      key = `${st.size}:${st.mtimeMs}`;
    } catch {
      return null;
    }
    const hit = this.cache.get(dir);
    if (hit?.key === key) return hit.chat;
    const recs = this.records(dir);
    const users = recs.filter((r) => r.kind === 'user' && typeof r.text === 'string');
    let chat: SavedChat | null = null;
    if (users.length) {
      const base = path.basename(dir);
      const lastDone = [...recs].reverse().find((r) => r.kind === 'turn_done' && r.finalText);
      const profiled = [...users].reverse().find((r) => r.profile);
      const from = recs.find((r) => r.kind === 'continued_from')?.sessionId;
      const owner = recs.find((r) => r.kind === 'session')?.client;
      chat = {
        dir,
        sessionId: base.slice(base.indexOf('_') + 1),
        title: titleOf(users[0].text),
        profileId: profiled?.profile,
        startedAt: Date.parse(recs[0]?.t) || 0,
        updatedAt: Date.parse(recs[recs.length - 1]?.t) || 0,
        messages: users.length,
        lastReply: lastDone ? truncate(String(lastDone.finalText).replace(/\s+/g, ' ').trim(), 160) : undefined,
        continuedFrom: typeof from === 'string' ? from : undefined,
        clientId: typeof owner === 'string' && owner ? owner : undefined,
      };
    }
    this.cache.set(dir, { key, chat });
    return chat;
  }

  /**
   * Saved chats, newest first. A chat that was carried on in a newer chat is folded into it
   * (the newer one shows the whole conversation and keeps the original title).
   */
  list(limit = 50, clientId?: string): SavedChat[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.root).sort().reverse();
    } catch {
      return [];
    }
    const chats: SavedChat[] = [];
    for (const n of names.slice(0, Math.max(limit * 3, 60))) {
      const c = this.read(path.join(this.root, n));
      if (c && this.visibleTo(c, clientId)) chats.push(c);
    }
    const byId = new Map(chats.map((c) => [c.sessionId, c]));
    const continued = new Set(chats.map((c) => c.continuedFrom).filter(Boolean));
    return chats
      .filter((c) => !continued.has(c.sessionId))
      .map((c) => ({ ...c, title: this.rootTitle(c, byId), startedAt: this.rootStart(c, byId) }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  /**
   * May this browser see the chat? Each paired browser sees its own chats. Chats saved before the
   * owner was recorded stay visible to all, and so does everything when no browser is given.
   */
  visibleTo(c: SavedChat, clientId?: string): boolean {
    return !clientId || !c.clientId || c.clientId === clientId;
  }

  /**
   * Delete saved chats (transcript and screenshots) that were last written more than `days` days
   * ago. Off unless a positive number of days is given. Only folders this server names and
   * writes are ever removed. Returns how many were deleted.
   */
  prune(days: number | undefined, now = new Date()): number {
    if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return 0;
    const cutoff = now.getTime() - days * 86_400_000;
    let names: string[];
    try {
      names = fs.readdirSync(this.root);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (!SAVED_CHAT_DIR.test(name)) continue;
      const dir = path.join(this.root, name);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        // Age is the last time anything was added to the chat, not when it began.
        if (fs.statSync(path.join(dir, 'events.jsonl')).mtimeMs >= cutoff) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        this.cache.delete(dir);
        removed++;
      } catch {
        /* not a saved chat, or it can't be removed: leave it */
      }
    }
    return removed;
  }

  private chain(c: SavedChat, byId?: Map<string, SavedChat>): SavedChat[] {
    const out = [c];
    let cur = c;
    while (cur.continuedFrom && out.length < MAX_CHAIN) {
      const id = cur.continuedFrom;
      const p = byId?.get(id) ?? this.find(id);
      if (!p || out.includes(p)) break;
      out.unshift(p);
      cur = p;
    }
    return out;
  }

  private rootTitle(c: SavedChat, byId?: Map<string, SavedChat>): string {
    return this.chain(c, byId)[0].title;
  }

  private rootStart(c: SavedChat, byId?: Map<string, SavedChat>): number {
    return this.chain(c, byId)[0].startedAt;
  }

  find(sessionId: string): SavedChat | null {
    const dir = this.dirOf(sessionId);
    return dir ? this.read(dir) : null;
  }

  /** Title for a chat that continues `sessionId` (the original chat's title). */
  titleFor(sessionId: string): string | undefined {
    const c = this.find(sessionId);
    return c ? this.rootTitle(c) : undefined;
  }

  /** Panel events that redraw a saved chat, including the chats it continued. */
  replay(sessionId: string): AgentEvent[] | null {
    const c = this.find(sessionId);
    if (!c) return null;
    const chain = this.chain(c);
    const events: AgentEvent[] = [];
    chain.forEach((part, i) => {
      if (i) events.push(CONTINUED_NOTICE);
      events.push(...this.replayOne(part.dir, part === c ? REPLAY_IMAGES : 0));
    });
    return events;
  }

  /** Events of the chats a live chat carries on from (shown above its own events). */
  replayBefore(continuedFrom: string): AgentEvent[] {
    const ev = this.replay(continuedFrom);
    return ev ? [...ev, CONTINUED_NOTICE] : [];
  }

  private replayOne(dir: string, maxImages: number): AgentEvent[] {
    const recs = this.records(dir);
    const withImages = recs.filter((r) => r.kind === 'tool' && r.imageFile);
    const showImage = new Set(maxImages ? withImages.slice(-maxImages) : []);
    const out: AgentEvent[] = [];
    let n = 0;
    for (const r of recs) {
      switch (r.kind) {
        case 'user':
          if (typeof r.text === 'string') out.push({ type: 'user_message', text: r.text });
          break;
        case 'assistant':
          for (const p of Array.isArray(r.parts) ? r.parts : []) {
            if (p?.type === 'thinking' && typeof p.text === 'string' && p.text.trim()) out.push({ type: 'thinking', text: p.text });
            else if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim()) out.push({ type: 'text', text: p.text });
          }
          break;
        case 'tool': {
          const callId = `saved-${++n}`;
          const member = String(r.member ?? 'tool');
          const input = r.input && typeof r.input === 'object' ? (r.input as Record<string, unknown>) : {};
          let summary = member;
          try {
            if (isBrowserMember(member)) summary = summarizeCall(member, input);
          } catch {
            /* keep the bare name */
          }
          out.push({ type: 'tool_call', callId, member, input, summary });
          let image: { mediaType: string; data: string } | undefined;
          if (showImage.has(r) && typeof r.imageFile === 'string' && /^image-\d+\.jpg$/.test(r.imageFile)) {
            try {
              image = { mediaType: 'image/jpeg', data: fs.readFileSync(path.join(dir, r.imageFile)).toString('base64') };
            } catch {
              /* image file gone */
            }
          }
          out.push({ type: 'tool_result', callId, isError: !!r.isError, text: truncate(String(r.text ?? ''), 4000), image });
          break;
        }
        case 'error':
          out.push({ type: 'notice', level: 'error', message: String(r.message ?? 'Error') });
          break;
        case 'turn_done':
          out.push({ type: 'turn_done', reason: r.reason ?? 'end_turn', finalText: String(r.finalText ?? '') });
          break;
      }
    }
    // The last turn may have been cut off by a restart.
    const last = recs[recs.length - 1];
    if (last && last.kind !== 'turn_done') out.push({ type: 'notice', level: 'warn', message: 'This chat was interrupted (the agent server stopped while it was working).' });
    return out;
  }

  /**
   * What the model is told when a saved chat is carried on: the user's messages and the agent's
   * replies, oldest first, trimmed from the start to fit.
   */
  recap(sessionId: string, maxChars = 12_000): string | null {
    const c = this.find(sessionId);
    if (!c) return null;
    const lines: string[] = [];
    for (const part of this.chain(c)) {
      for (const r of this.records(part.dir)) {
        if (r.kind === 'user' && typeof r.text === 'string') lines.push(`User: ${r.text.trim()}`);
        else if (r.kind === 'turn_done' && r.finalText) lines.push(`You (agent): ${String(r.finalText).trim()}`);
        else if (r.kind === 'tool' && r.member === 'navigate' && !r.isError && typeof r.text === 'string') {
          const m = r.text.match(/^Navigated to (\S+)/);
          if (m) lines.push(`(You opened ${truncate(m[1], 200)})`);
        }
      }
    }
    const kept: string[] = [];
    let size = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = truncate(lines[i], 3000);
      if (size + l.length > maxChars && kept.length) {
        kept.unshift('(earlier messages left out)');
        break;
      }
      kept.unshift(l);
      size += l.length + 1;
    }
    return [
      'This chat carries on from an earlier conversation with the user. Here is what was said in it, oldest first:',
      '---',
      ...kept,
      '---',
      "The browser tabs from that conversation may have been closed or may have changed, so check the current page before relying on them. Continue from where it left off, following the user's new message below.",
    ].join('\n');
  }
}

const CONTINUED_NOTICE: AgentEvent = { type: 'notice', level: 'info', message: 'Continued in a new chat — the agent was given a summary of the conversation above.' };

function titleOf(text: string): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), 60) || 'New task';
}
