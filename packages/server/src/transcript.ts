/**
 * Per-session transcripts: data/sessions/<date>_<sessionId>/events.jsonl, with screenshots
 * written as separate files. These are the raw material for debugging and evals.
 */
import fs from 'node:fs';
import path from 'node:path';

export class TranscriptWriter {
  private dirs = new Map<string, string>();
  private imageN = new Map<string, number>();

  constructor(
    private root: string,
    private enabled = true,
  ) {}

  dirFor(sessionId: string): string {
    let d = this.dirs.get(sessionId);
    if (!d) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      d = path.join(this.root, 'sessions', `${stamp}_${sessionId}`);
      this.dirs.set(sessionId, d);
      if (this.enabled) fs.mkdirSync(d, { recursive: true });
    }
    return d;
  }

  write(sessionId: string, record: Record<string, unknown>): void {
    if (!this.enabled) return;
    try {
      const dir = this.dirFor(sessionId);
      const rec: Record<string, unknown> = { t: new Date().toISOString(), ...record };
      if (typeof rec.imageData === 'string') {
        const n = (this.imageN.get(sessionId) ?? 0) + 1;
        this.imageN.set(sessionId, n);
        const file = `image-${String(n).padStart(4, '0')}.jpg`;
        fs.writeFileSync(path.join(dir, file), Buffer.from(rec.imageData as string, 'base64'));
        delete (rec as Record<string, unknown>).imageData;
        (rec as Record<string, unknown>).imageFile = file;
      }
      fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(rec) + '\n');
    } catch {
      /* logging must never break a session */
    }
  }
}
