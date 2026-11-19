import { z } from "zod";
import { Rooms, HttpError } from "../server/rooms.js";
import { actionSchema, secretSchema } from "../shared/protocol.js";
import { allowedOrigin } from "../shared/http-utils.js";

type Env = {
  ROOMS: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
  ASSETS: { fetch(request: Request): Promise<Response> };
};
const response = (value: unknown, status = 200) => Response.json(value, {
  status,
  headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" },
});
const nameSchema = z.object({ name: z.string().trim().min(1).max(48) }).strict();

async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new HttpError(415, "json-required");
  if (Number(request.headers.get("content-length") ?? 0) > 16384)
    throw new HttpError(413, "body-too-large");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid-json");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new HttpError(413, "body-too-large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HttpError(400, "invalid-json"); }
}

// A single coordinator prevents split authority across Worker isolates. Rooms are
// intentionally ephemeral; eviction/deployment invalidates sessions and invitations.
export class PulsePartyRooms {
  private readonly rooms = new Rooms({ maxRooms: 128 });
  private readonly pending = new Map<string, () => void>();
  private readonly buckets = new Map<string, { count: number; reset: number }>();

  async fetch(request: Request): Promise<Response> {
    const origin = request.headers.get("origin");
    try {
      if (origin && !allowedOrigin(origin)) throw new HttpError(403, "origin-denied");
      const result = await this.handle(request);
      if (origin) {
        result.headers.set("Access-Control-Allow-Origin", origin);
        result.headers.set("Vary", "Origin");
      }
      return result;
    } catch (error) {
      const result = response({ code: error instanceof HttpError ? error.code
        : error instanceof z.ZodError ? "invalid-request" : "internal-error" },
        error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500);
      if (origin && allowedOrigin(origin)) {
        result.headers.set("Access-Control-Allow-Origin", origin);
        result.headers.set("Vary", "Origin");
      }
      return result;
    }
  }

  private async handle(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Max-Age": "600",
    } });
    const now = Date.now();
    this.rooms.sweep();
    for (const [ip, b] of this.buckets) if (b.reset <= now) this.buckets.delete(ip);
    const ip = request.headers.get("CF-Connecting-IP") ?? "local";
    const key = request.method === "POST" && new URL(request.url).pathname === "/v1/rooms"
      ? "create:" + ip : "request:" + ip;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= 4096) throw new HttpError(503, "busy");
      bucket = { count: 0, reset: now + 60_000 };
      this.buckets.set(key, bucket);
    }
    if (++bucket.count > (key.startsWith("create:") ? 10 : 1200))
      throw new HttpError(429, "rate-limit");
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/v1/health")
      return response({ ok: true, protocol: 1, build: "0.3.0" });
    if (request.method === "POST" && path === "/v1/rooms") {
      const value = nameSchema.parse(await body(request));
      return response(this.rooms.create(value.name), 201);
    }
    if (request.method === "POST" && path === "/v1/join") {
      const value = nameSchema.extend({ invite: secretSchema }).parse(await body(request));
      return response(this.rooms.join(value.invite, value.name));
    }
    if (request.method === "POST" && path === "/v1/invite/check") {
      const value = z.object({ invite: secretSchema }).strict().parse(await body(request));
      const room = this.rooms.validateInvite(value.invite);
      return response({ valid: true, roomId: room.id, size: room.members.size, maxSize: this.rooms.config.maxSize });
    }
    const raw = request.headers.get("authorization");
    if (!raw?.startsWith("Bearer ")) throw new HttpError(401, "token-required");
    const token = secretSchema.parse(raw.slice(7));
    if (request.method === "POST" && path === "/v1/action")
      return response(this.rooms.act(token, actionSchema.parse(await body(request))));
    const { room, member } = this.rooms.authenticate(token);
    if (request.method === "GET" && path === "/v1/snapshot")
      return response({ snapshot: this.rooms.snapshot(room) });
    if (request.method === "GET" && path === "/v1/poll") {
      const after = z.coerce.number().int().nonnegative().parse(new URL(request.url).searchParams.get("after"));
      if (room.revision > after) return response({ snapshot: this.rooms.snapshot(room) });
      // A reconnect can arrive before Cloudflare reports a closed upstream request.
      this.pending.get(member.id)?.();
      return new Promise<Response>((resolve) => {
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          this.rooms.events.off(room.id, done);
          this.pending.delete(member.id);
          request.signal.removeEventListener("abort", done);
          try {
            this.rooms.sweep();
            this.rooms.authenticate(token);
            resolve(response({ snapshot: this.rooms.snapshot(room) }));
          } catch { resolve(response({ code: "session-expired" }, 401)); }
        };
        const timer = setTimeout(done, 10_000);
        this.pending.set(member.id, done);
        this.rooms.events.on(room.id, done);
        request.signal.addEventListener("abort", done, { once: true });
        if (request.signal.aborted) done();
      });
    }
    throw new HttpError(404, "not-found");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/v1/"))
      return env.ROOMS.getByName("pulseparty-rooms-v2").fetch(request);
    if (request.method !== "GET" || !["/", "/invite", "/invite.js", "/invite.css"].includes(url.pathname))
      return response({ code: "not-found" }, 404);
    if (url.pathname === "/" || url.pathname === "/invite") url.pathname = "/invite.html";
    const asset = await env.ASSETS.fetch(new Request(url, request));
    const result = new Response(asset.body, asset);
    result.headers.set("Cache-Control", "no-store");
    result.headers.set("Referrer-Policy", "no-referrer");
    result.headers.set("X-Content-Type-Options", "nosniff");
    result.headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    return result;
  },
};
