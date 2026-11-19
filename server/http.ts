import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { actionSchema, secretSchema } from "../shared/protocol.js";
import { Rooms, HttpError } from "./rooms.js";
import {body,json,bearer,allowedOrigin} from '../shared/http-utils.js';
export function createRelay(rooms = new Rooms()) {
  const buckets = new Map<string, { count: number; reset: number }>();
  const pending = new Set<string>();
  const server = createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      if (origin && !allowedOrigin(origin)) throw new HttpError(403, "origin-denied");
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
          "Access-Control-Max-Age": "600",
        });
        res.end();
        return;
      }
      const ip = req.socket.remoteAddress ?? "unknown";
      const now = Date.now();
      let bucket = buckets.get(ip);
      if (!bucket || bucket.reset < now) {
        bucket = { count: 0, reset: now + 60_000 };
        buckets.set(ip, bucket);
      }
      if (++bucket.count > 1200) throw new HttpError(429, "rate-limit");
      const url = new URL(req.url ?? "/", "http://relay");
      if (req.method === "GET" && ["/health", "/v1/health"].includes(url.pathname)) {
        json(res, 200, { ok: true, protocol: 1 });
        return;
      }
      if (
        req.method === "GET" &&
        (url.pathname === "/invite" ||
          url.pathname === "/invite.js" ||
          url.pathname === "/invite.css")
      ) {
        const file = url.pathname === "/invite" ? "invite.html" : url.pathname.slice(1);
        const content = await readFile(new URL("../web/" + file, import.meta.url)).catch(() =>
          readFile(new URL("../../web/" + file, import.meta.url)),
        );
        res.writeHead(200, {
          "Content-Type": file.endsWith(".html")
            ? "text/html; charset=utf-8"
            : file.endsWith(".js")
              ? "text/javascript; charset=utf-8"
              : "text/css; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(content);
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/rooms") {
        const b = z
          .object({ name: z.string().trim().min(1).max(48) })
          .strict()
          .parse(await body(req));
        json(res, 201, rooms.create(b.name));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/join") {
        const b = z
          .object({ invite: secretSchema, name: z.string().trim().min(1).max(48) })
          .strict()
          .parse(await body(req));
        json(res, 200, rooms.join(b.invite, b.name));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/invite/check") {
        const b = z
          .object({ invite: secretSchema })
          .strict()
          .parse(await body(req));
        const room = rooms.validateInvite(b.invite);
        json(res, 200, {
          valid: true,
          roomId: room.id,
          size: room.members.size,
          maxSize: rooms.config.maxSize,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/snapshot") {
        const { room } = rooms.authenticate(bearer(req));
        json(res, 200, { snapshot: rooms.snapshot(room) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/action") {
        json(res, 200, rooms.act(bearer(req), actionSchema.parse(await body(req))));
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/poll") {
        const raw = bearer(req);
        const { room, member } = rooms.authenticate(raw);
        const revision = z.coerce.number().int().nonnegative().parse(url.searchParams.get("after"));
        if (pending.has(member.id)) throw new HttpError(429, "poll-already-open");
        if (room.revision > revision) {
          json(res, 200, { snapshot: rooms.snapshot(room) });
          return;
        }
        pending.add(member.id);
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          rooms.events.off(room.id, done);
          pending.delete(member.id);
          res.off("close", cleanup);
          try {
            rooms.authenticate(raw);
            json(res, 200, { snapshot: rooms.snapshot(room) });
          } catch {
            json(res, 401, { code: "session-expired" });
          }
        };
        const cleanup = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          rooms.events.off(room.id, done);
          pending.delete(member.id);
        };
        const timer = setTimeout(done, 10_000);
        rooms.events.on(room.id, done);
        res.on("close", cleanup);
        return;
      }
      throw new HttpError(404, "not-found");
    } catch (error) {
      if (res.headersSent) return;
      json(
        res,
        error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500,
        {
          code:
            error instanceof HttpError
              ? error.code
              : error instanceof z.ZodError
                ? "invalid-request"
                : "internal-error",
        },
      );
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 2048;
  const timer = setInterval(() => {
    rooms.sweep();
    for (const [ip, b] of buckets) if (b.reset < Date.now()) buckets.delete(ip);
  }, 1000);
  timer.unref();
  server.on("close", () => clearInterval(timer));
  return { server, rooms };
}
