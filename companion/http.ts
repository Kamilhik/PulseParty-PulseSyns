import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { bearer, body, json, allowedOrigin } from '../shared/http-utils.js';
import { HttpError } from '../server/rooms.js';
import { identifier, playbackSchema, secretSchema, positionAt } from '../shared/protocol.js';
import { PendingInvites } from './pending.js';
import type { DiscordWorker } from './native-worker.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const presenceSchema = z.object({ snapshot: z.object({ roomId: identifier, revision: z.number().int().nonnegative(), epoch: z.number().int().nonnegative(), serverTime: z.number().finite(), hostId: identifier, ownerId: identifier, closed: z.boolean(), profileJoin: z.boolean(), maxSize: z.number().int().min(1).max(256), members: z.array(z.object({ id: identifier, name: z.string().max(48) })).max(256), playback: playbackSchema.extend({ at: z.number().finite() }) }), memberId: identifier, joinSecret: secretSchema.nullable() }).strict();
export type Pairing = { tokenHash: string; origin: string } | null;
export function createCompanion(options: { relay: string; worker: DiscordWorker; launchSecret: string; port?: number; pairing?: Pairing; savePairing?: (p: Pairing) => Promise<void>; validate?: (invite: string) => Promise<void>; activityType?: 'listening' | 'playing'; now?: () => number; onInvite?: () => void }) {
  const now = options.now ?? Date.now; const pending = new PendingInvites(options.relay, now);
  const code = randomBytes(12).toString('base64url'); const codeExpires = now() + 300_000; let pairing = options.pairing ?? null; let consumed = false; let attempts = 0; let lastRequest = 0; let requests = 0; let lease = 0; let room = '';
  const validate = options.validate ?? (async (invite: string) => { const response = await fetch(options.relay + '/v1/invite/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite }), signal: AbortSignal.timeout(5000), redirect: 'error' }); if (!response.ok) throw new HttpError(410, 'invite-expired'); });
  const receive = async (invite: string) => { secretSchema.parse(invite); await validate(invite); if (pending.add(invite)) options.onInvite?.(); };
  const join = (invite: string) => { void receive(invite).catch(() => {}); }; options.worker.events.on('join', join);
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host; const port = (server.address() as { port: number } | null)?.port ?? options.port ?? 18787;
      if (host !== '127.0.0.1:' + port) throw new HttpError(403, 'host-denied');
      const origin = req.headers.origin;
      if (origin && !allowedOrigin(origin)) throw new HttpError(403, 'origin-denied');
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') { if (!origin) throw new HttpError(403, 'origin-required'); res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' }); res.end(); return; }
      if (req.method !== 'POST') throw new HttpError(405, 'post-required');
      if (now() - lastRequest > 60_000) { requests = 0; lastRequest = now(); } if (++requests > 180) throw new HttpError(429, 'rate-limit');
      if (req.url === '/v1/launch') {
        if (origin || !equal(bearer(req), options.launchSecret)) throw new HttpError(403, 'launch-denied');
        const b = z.object({ invite: secretSchema }).strict().parse(await body(req)); await receive(b.invite); json(res, 200, { ok: true }); return;
      }
      if (!origin || !allowedOrigin(origin)) throw new HttpError(403, 'origin-required');
      if (req.url === '/v1/pair') {
        if (++attempts > 10 || consumed || now() >= codeExpires) throw new HttpError(403, 'pairing-denied');
        const b = z.object({ code: z.string().max(32) }).strict().parse(await body(req)); if (!equal(b.code, code)) throw new HttpError(403, 'pairing-denied');
        consumed = true; const token = randomBytes(32).toString('base64url'); pairing = { tokenHash: hash(token), origin }; await options.savePairing?.(pairing); json(res, 200, { token }); return;
      }
      if (!pairing || !equal(hash(bearer(req)), pairing.tokenHash) || (origin !== pairing.origin && !/^https:\/\/addon-\d+\.pulsesync\.invalid$/.test(origin))) throw new HttpError(401, 'not-paired');
      if (req.url === '/v1/status') { await body(req); json(res, 200, { discord: options.worker.status, pending: pending.peek() }); return; }
      if (req.url === '/v1/ack') { const b = z.object({ id: z.string().uuid() }).strict().parse(await body(req)); pending.ack(b.id); json(res, 200, { ok: true }); return; }
      if (req.url === '/v1/clear') { await body(req); options.worker.clear(); lease = 0; room = ''; json(res, 200, { ok: true }); return; }
      if (req.url === '/v1/presence') {
        const { snapshot: s, memberId, joinSecret } = presenceSchema.parse(await body(req));
        if (!s.members.some(m => m.id === memberId)) throw new HttpError(400, 'member-missing');
        const joinable = !s.closed && s.profileJoin && s.members.length < s.maxSize && memberId === s.ownerId && !!joinSecret;
        if (joinable) await validate(joinSecret!);
        const p = s.playback; const position = positionAt(p, s.serverTime); const clock = now(); const start = p.playing && p.track ? Math.floor((clock - position) / 1000) : 0;
        if (s.closed) { options.worker.clear(); lease = 0; }
        else { options.worker.update({ type: options.activityType ?? 'listening', title: p.track?.title || 'Слушаем вместе', artist: p.track?.artist || 'PulseParty', cover: p.track?.cover || '', state: (p.playing ? 'Слушаем' : 'Пауза') + ' · ' + (s.hostId === memberId ? 'Вы ведущий' : 'Ведущий: ' + (s.members.find(m => m.id === s.hostId)?.name ?? 'переподключается')), roomId: s.roomId, size: s.members.length, maxSize: s.maxSize, start, end: start && p.track ? Math.floor((clock + p.track.durationMs - position) / 1000) : 0, joinSecret: joinable ? joinSecret! : '', url: joinable ? options.relay + '/invite#' + joinSecret : '' }); lease = clock + 15_000; room = s.roomId; }
        json(res, 200, { ok: true, joinable }); return;
      }
      throw new HttpError(404, 'not-found');
    } catch (error) { if (!res.headersSent) json(res, error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500, { code: error instanceof HttpError ? error.code : error instanceof z.ZodError ? 'invalid-request' : 'internal-error' }); }
  });
  const timer = setInterval(() => { if (lease && now() > lease) { options.worker.clear(); lease = 0; room = ''; } }, 1000); timer.unref();
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxConnections = 32;
  server.on('close', () => { clearInterval(timer); options.worker.events.off('join', join); options.worker.stop(); });
  return { server, code, pending, receive };
}
