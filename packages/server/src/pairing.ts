/**
 * Pairing and mutual authentication between the extension and this server.
 *
 * Handshake (protocol 2): the extension sends a random nonce; the server proves it knows the
 * shared secret with HMAC(secret, "ba-server:" + nonce); only then does the extension answer the
 * server's nonce with HMAC(secret, "ba-client:" + serverNonce). The secret itself never crosses
 * the wire, so a program squatting on the port learns nothing and can't drive the browser.
 *
 * The secret is either the server's pairing token (pasted into Settings) or a per-browser secret
 * from pairing. Pairing is a key exchange with numeric comparison, like Bluetooth: the user starts
 * it in the side panel, both sides derive the secret from an ECDH exchange (it never crosses the
 * wire), and both show the same 6-digit code. The user confirms the match in the side panel AND
 * approves it in the server window. A program squatting on the port has no server window showing
 * that code; a rogue local client's code won't match the panel.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { AUTH_CLIENT_LABEL, AUTH_SERVER_LABEL, AUTH_WHOAMI_LABEL, PAIR_CODE_LABEL, PAIR_CONFIRM_LABEL, PAIR_SECRET_LABEL } from '@ba/shared';

export const hmac = (key: string, msg: string): string => crypto.createHmac('sha256', key).update(msg).digest('hex');
export const serverProof = (key: string, clientNonce: string) => hmac(key, AUTH_SERVER_LABEL + clientNonce);
export const clientProof = (key: string, serverNonce: string) => hmac(key, AUTH_CLIENT_LABEL + serverNonce);
export const whoamiProof = (key: string, nonce: string) => hmac(key, AUTH_WHOAMI_LABEL + nonce);
export const newNonce = () => crypto.randomBytes(24).toString('hex');

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const CLIENT_ID = /^[\w-]{1,100}$/;

export const sha256Hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Server side of one pairing exchange, commit-then-reveal: the client first commits to
 * SHA-256(its public key); we send our key; then it reveals its key, which must match.
 */
export function startPairingExchange(commit: string): { serverPub: string; reveal: (clientPubB64: string) => { secret: string; code: string; confirm: string } } {
  if (!/^[0-9a-f]{64}$/.test(commit)) throw new Error('Invalid pairing request.');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const serverPub = ecdh.getPublicKey().toString('base64');
  return {
    serverPub,
    reveal(clientPubB64: string) {
      if (typeof clientPubB64 !== 'string' || !safeEqualHex(sha256Hex(clientPubB64), commit)) throw new Error('The revealed key does not match the commitment.');
      const clientPub = Buffer.from(clientPubB64, 'base64');
      if (clientPub.length !== 65 || clientPub[0] !== 4) throw new Error('Invalid pairing key.');
      const shared = ecdh.computeSecret(clientPub); // throws for points not on the curve
      return pairingDerive(shared, clientPubB64, serverPub);
    },
  };
}

/** Same derivation the extension does with WebCrypto. */
export function pairingDerive(shared: Buffer, clientPub: string, serverPub: string): { secret: string; code: string; confirm: string } {
  const transcript = `${clientPub}|${serverPub}`;
  const mac = (label: string, key: Buffer | string = shared) => crypto.createHmac('sha256', key).update(label + transcript).digest();
  const secret = mac(PAIR_SECRET_LABEL).toString('base64url');
  const code = String(mac(PAIR_CODE_LABEL).readUInt32BE(0) % 1_000_000).padStart(6, '0');
  const confirm = mac(PAIR_CONFIRM_LABEL, secret).toString('hex');
  return { secret, code, confirm };
}

interface PairedEntry {
  secret: string;
  pairedAt: string;
  userAgent?: string;
}

/** Per-browser secrets issued by code pairing (data/paired.json, owner-only). */
export class PairedClients {
  private file: string;
  private clients: Record<string, PairedEntry> = {};

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'paired.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw.clients === 'object') this.clients = raw.clients;
    } catch {
      /* none yet */
    }
  }

  secretFor(clientId: string): string | undefined {
    return CLIENT_ID.test(clientId) ? this.clients[clientId]?.secret : undefined;
  }

  store(clientId: string, secret: string, userAgent?: string): void {
    if (!CLIENT_ID.test(clientId)) throw new Error('Invalid client id.');
    this.clients[clientId] = { secret, pairedAt: new Date().toISOString(), userAgent: userAgent?.slice(0, 200) };
    this.save();
  }

  forget(clientId: string): void {
    delete this.clients[clientId];
    this.save();
  }

  private save(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ clients: this.clients }, null, 2), { mode: 0o600 });
    } catch {
      /* data dir may be read-only in tests */
    }
  }
}

export interface PairRequest {
  clientId: string;
  code: string;
  userAgent?: string;
  origin?: string;
}

/** Asks the user to approve a pairing request. Resolves true to pair. */
export type PairPrompter = (req: PairRequest) => Promise<boolean>;

/**
 * Prompter for an interactive server window: prints the code and waits for "y". Returns
 * undefined when stdin isn't a terminal (background service): pairing then needs the token.
 */
export function consolePairPrompter(timeoutMs = 90_000): PairPrompter | undefined {
  if (!process.stdin.isTTY) return undefined;
  return (req) =>
    new Promise<boolean>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const browser = /Edg\//.test(req.userAgent ?? '') ? 'Edge' : /Chrome\//.test(req.userAgent ?? '') ? 'Chrome' : 'a browser';
      const timer = setTimeout(() => {
        console.log('\n  Pairing request timed out.');
        rl.close();
        resolve(false);
      }, timeoutMs);
      rl.question(
        `\n  >>> ${browser} wants to pair with this server.  Pairing code:  ${req.code}\n` +
          '      Approve ONLY if you just clicked "Pair" and the side panel shows this same code. Pair? [y/N] ',
        (answer) => {
          clearTimeout(timer);
          rl.close();
          const ok = /^y(es)?$/i.test(answer.trim());
          console.log(ok ? '  Paired.\n' : '  Declined.\n');
          resolve(ok);
        },
      );
    });
}
