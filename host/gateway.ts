import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { body, json, bearer, allowedOrigin } from "../shared/http-utils.js";
import { HttpError } from "../server/rooms.js";
import { positionAt } from "../shared/protocol.js";
import { decodeCode, peerIdSchema } from "../shared/iroh-code.js";
import { PendingInvites } from "../companion/pending.js";
import type { DiscordWorker } from "../companion/native-worker.js";
import { IrohNetwork } from "./iroh-network.js";
export function createEmbeddedGateway(options: {
  network: IrohNetwork;
  bridgeToken: string;
  worker: DiscordWorker;
  configure?: (appId: string, type: "listening" | "playing") => void;
  activityType?: () => "listening" | "playing";
  onInvite?: () => void;
  rpcDisabled: () => boolean;
}) {
  const { network, worker } = options;
  const pending = new PendingInvites("http://127.0.0.1:18787");
  let lease = 0;
  const receive = async (code: string) => {
    decodeCode(code);
    await network.validate(code);
    if (pending.add(code)) options.onInvite?.();
  };
  const join = (code: string) => {
    void receive(code).catch(() => {});
  };
  worker.events.on("join", join);
  const server = createServer(async (req, res) => {
    try {
      const port = (server.address() as { port: number } | null)?.port ?? 18787;
      if (req.headers.host !== "127.0.0.1:" + port) throw new HttpError(403, "host-denied");
      const origin = req.headers.origin;
      if (!allowedOrigin(origin)) throw new HttpError(403, "origin-denied");
      res.setHeader("Access-Control-Allow-Origin", origin!);
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type,Authorization,X-PulseParty-Bridge,X-PulseParty-Coordinator",
        });
        res.end();
        return;
      }
      const auth = req.headers["x-pulseparty-bridge"];
      if (
        typeof auth !== "string" ||
        auth.length !== options.bridgeToken.length ||
        !timingSafeEqual(Buffer.from(auth), Buffer.from(options.bridgeToken))
      )
        throw new HttpError(401, "bridge-token-required");
      const url = new URL(req.url ?? "/", "http://local");
      const route = url.pathname.slice("/v1/".length);
      if (!url.pathname.startsWith("/v1/")) throw new HttpError(404, "not-found");
      const data = req.method === "POST" ? await body(req) : undefined;
      if (route === "rooms" && req.method === "POST") {
        const b = z
          .object({ name: z.string().trim().min(1).max(48) })
          .strict()
          .parse(data);
        json(res, 200, network.create(b.name));
        return;
      }
      if (route === "join" && req.method === "POST") {
        const b = z
          .object({ name: z.string().trim().min(1).max(48), invite: z.string().max(160) })
          .strict()
          .parse(data);
        json(res, 200, await network.join(b.invite, b.name));
        return;
      }
      if (["snapshot", "action", "poll"].includes(route)) {
        if ((route === "action") !== (req.method === "POST"))
          throw new HttpError(405, "method-denied");
        const peer = peerIdSchema.parse(req.headers["x-pulseparty-coordinator"]);
        json(
          res,
          200,
          await network.request(peer, {
            path: route as "snapshot" | "action" | "poll",
            token: bearer(req),
            ...(route === "action" ? { data } : {}),
            ...(route === "poll"
              ? {
                  after: z.coerce.number().int().nonnegative().parse(url.searchParams.get("after")),
                }
              : {}),
          }),
        );
        return;
      }
      if (req.method !== "POST") throw new HttpError(405, "post-required");
      if (route === "status") {
        json(res, 200, {
          discord: worker.status,
          pending: pending.peek(),
          embedded: true,
          peerId: network.peerId,
        });
        return;
      }
      if (route === "ack") {
        const b = z.object({ id: z.string().uuid() }).strict().parse(data);
        pending.ack(b.id);
        json(res, 200, { ok: true });
        return;
      }
      if (route === "configure") {
        if (!options.rpcDisabled()) throw new HttpError(409, "presence-conflict");
        const b = z
          .object({
            applicationId: z.string().regex(/^\d{17,20}$/),
            activityType: z.enum(["listening", "playing"]).default("listening"),
          })
          .strict()
          .parse(data);
        options.configure?.(b.applicationId, b.activityType);
        json(res, 200, { ok: true });
        return;
      }
      if (route === "clear") {
        worker.clear();
        lease = 0;
        json(res, 200, { ok: true });
        return;
      }
      if (route === "presence") {
        if (!options.rpcDisabled()) {
          worker.clear();
          throw new HttpError(409, "presence-conflict");
        }
        const b = z
          .object({
            snapshot: z.object({
              roomId: z.string(),
              ownerId: z.string(),
              hostId: z.string(),
              members: z.array(z.object({ id: z.string(), name: z.string().max(48) })).max(16),
              maxSize: z.number().int().min(1).max(16),
              profileJoin: z.boolean(),
              closed: z.boolean(),
              playback: z.unknown(),
              serverTime: z.number(),
            }),
            memberId: z.string(),
            joinSecret: z.string().max(160).nullable(),
          })
          .parse(data);
        // Do not trust a renderer to invent room state for presence. Read the authority.
        const peer = peerIdSchema.parse(req.headers["x-pulseparty-coordinator"]);
        const envelope = await network.request(peer, { path: "snapshot", token: bearer(req) });
        if (!("snapshot" in envelope)) throw new HttpError(400, "invalid-room");
        const s = envelope.snapshot;
        if (!s.members.some((m) => m.id === b.memberId)) throw new HttpError(403, "member-missing");
        const p = s.playback;
        let joinSecret = "";
        if (
          b.joinSecret &&
          !s.closed &&
          s.profileJoin &&
          s.ownerId === b.memberId &&
          s.members.length < s.maxSize
        ) {
          const code = decodeCode(b.joinSecret);
          const checked = await network.validate(b.joinSecret);
          if (code.peerId !== peer || !("roomId" in checked) || checked.roomId !== s.roomId)
            throw new HttpError(400, "invite-room-mismatch");
          joinSecret = b.joinSecret;
        }
        const position = positionAt(p, s.serverTime),
          now = Date.now();
        const start = p.playing && p.track ? Math.floor((now - position) / 1000) : 0;
        if (s.closed) worker.clear();
        else
          worker.update({
            type: options.activityType?.() ?? "listening",
            title: p.track?.title || "Слушаем вместе",
            artist: p.track?.artist || "PulseParty",
            cover: p.track?.cover || "",
            state:
              (p.playing ? "Слушаем" : "Пауза") +
              " · " +
              (s.hostId === b.memberId
                ? "Вы ведущий"
                : "Ведущий: " +
                  (s.members.find((m) => m.id === s.hostId)?.name ?? "переподключается")),
            roomId: s.roomId,
            size: s.members.length,
            maxSize: s.maxSize,
            start,
            end: start && p.track ? Math.floor((now + p.track.durationMs - position) / 1000) : 0,
            joinSecret,
            url: "",
          });
        lease = now + 15000;
        json(res, 200, { ok: true });
        return;
      }
      throw new HttpError(404, "not-found");
    } catch (error) {
      if (!res.headersSent)
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
  const timer = setInterval(() => {
    if (lease && Date.now() > lease) {
      worker.clear();
      lease = 0;
    }
  }, 1000);
  timer.unref();
  server.requestTimeout = 15000;
  server.headersTimeout = 5000;
  server.maxConnections = 64;
  server.on("close", () => {
    clearInterval(timer);
    worker.events.off("join", join);
    worker.stop();
  });
  return { server, pending, receive };
}
