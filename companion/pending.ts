import { randomUUID, createHash } from 'node:crypto';
import { parseInvite } from '../shared/protocol.js';
export class PendingInvites {
  private items: { id: string; invite: string; expiresAt: number; hash: string }[] = [];
  private seen = new Map<string, number>();
  constructor(private relay: string, private now = Date.now) {}
  add(input: string) {
    const invite = parseInvite(input, this.relay); const hash = createHash('sha256').update(invite).digest('hex'); this.sweep();
    if (this.seen.has(hash)) return false;
    this.seen.set(hash, this.now() + 180_000); this.items.push({ id: randomUUID(), invite, expiresAt: this.now() + 180_000, hash }); if (this.items.length > 8) this.items.shift(); return true;
  }
  peek() { this.sweep(); const p = this.items[0]; return p ? { id: p.id, invite: p.invite } : null; }
  ack(id: string) { this.items = this.items.filter(p => p.id !== id); }
  private sweep() { this.items = this.items.filter(p => p.expiresAt > this.now()); for (const [key, expiry] of this.seen) if (expiry <= this.now()) this.seen.delete(key); }
}
