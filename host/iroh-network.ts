import { Endpoint, EndpointAddr, EndpointId, type Connection } from "@number0/iroh";
import { z } from "zod";
import { actionSchema, identifier, secretSchema, type Envelope } from "../shared/protocol.js";
import { encodeCode, decodeCode, peerIdSchema } from "../shared/iroh-code.js";
import { Rooms, HttpError } from "../server/rooms.js";
const ALPN = Array.from(Buffer.from("pulseparty/1"));
const wire = z
  .object({
    path: z.enum(["join", "snapshot", "action", "poll", "check"]),
    token: secretSchema.optional(),
    data: z.unknown().optional(),
    after: z.number().int().nonnegative().optional(),
  })
  .strict();
export type WireRequest = z.infer<typeof wire>;
type WireResponse = {
  status: number;
  result: Envelope | { code: string } | { valid: boolean; roomId: string };
};
function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new HttpError(504, "peer-timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
export class IrohNetwork {
  readonly rooms: Rooms;
  private connections = new Map<string, Connection>();
  private incoming = new Set<Connection>();
  private stopped = false;
  private timer: ReturnType<typeof setInterval>;
  private rates = new Map<string, { at: number; count: number }>();
  private polls = new Set<string>();
  private inflight = new Map<string, number>();
  private constructor(
    readonly endpoint: Endpoint,
    rooms?: Rooms,
    private resolver?: (peerId: string) => EndpointAddr,
  ) {
    this.rooms = rooms ?? new Rooms({ maxRooms: 8 });
    this.timer = setInterval(() => {
      this.rooms.sweep();
      for (const [p, r] of this.rates) if (Date.now() - r.at > 60000) this.rates.delete(p);
    }, 1000);
    this.timer.unref();
    void this.accept();
  }
  static async start(
    options: {
      endpoint?: Endpoint;
      rooms?: Rooms;
      resolver?: (peerId: string) => EndpointAddr;
    } = {},
  ) {
    const endpoint = options.endpoint ?? (await Endpoint.bind({ alpns: [ALPN] }));
    endpoint.setAlpns([ALPN]);
    return new IrohNetwork(endpoint, options.rooms, options.resolver);
  }
  get peerId() {
    return this.endpoint.id().toString();
  }
  create(name: string) {
    const result = this.rooms.create(name);
    result.session!.coordinator = this.peerId;
    return result;
  }
  private async accept() {
    while (!this.stopped) {
      try {
        const incoming = await this.endpoint.acceptNext();
        if (!incoming) break;
        if (this.incoming.size >= 64) {
          incoming.refuse();
          continue;
        }
        const connection = await timeout((await incoming.accept()).connect(), 5000);
        this.incoming.add(connection);
        void this.serve(connection).finally(() => this.incoming.delete(connection));
      } catch {
        if (this.stopped) break;
      }
    }
  }
  private async serve(connection: Connection) {
    const peer = connection.remoteId().toString();
    try {
      while (!this.stopped) {
        const stream = await connection.acceptBi();
        const count = this.inflight.get(peer) ?? 0;
        if (count >= 8) {
          connection.close(1n, []);
          break;
        }
        this.inflight.set(peer, count + 1);
        void (async () => {
          try {
            const now = Date.now();
            let rate = this.rates.get(peer);
            if (!rate || now - rate.at > 60000) {
              rate = { at: now, count: 0 };
              this.rates.set(peer, rate);
            }
            if (++rate.count > 240) throw new HttpError(429, "rate-limit");
            const bytes = await timeout(stream.recv.readToEnd(16384), 5000);
            let request: WireRequest;
            try {
              request = wire.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
            } catch {
              throw new HttpError(400, "invalid-request");
            }
            const result = await this.handle(request);
            await stream.send.writeAll(
              Array.from(Buffer.from(JSON.stringify({ status: 200, result }))),
            );
            await stream.send.finish();
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 400;
            try {
              await stream.send.writeAll(
                Array.from(
                  Buffer.from(
                    JSON.stringify({
                      status,
                      result: { code: error instanceof HttpError ? error.code : "invalid-request" },
                    }),
                  ),
                ),
              );
              await stream.send.finish();
            } catch {}
          } finally {
            this.inflight.set(peer, Math.max(0, (this.inflight.get(peer) ?? 1) - 1));
          }
        })();
      }
    } catch {
      /* peer disconnected */
    } finally {
      connection.close(0n, []);
    }
  }
  private async handle(
    request: WireRequest,
  ): Promise<Envelope | { valid: boolean; roomId: string }> {
    if (request.path === "join") {
      const b = z
        .object({ invite: secretSchema, name: z.string().trim().min(1).max(48) })
        .strict()
        .parse(request.data);
      return this.rooms.join(b.invite, b.name);
    }
    if (request.path === "check") {
      const b = z.object({ invite: secretSchema }).strict().parse(request.data);
      const room = this.rooms.validateInvite(b.invite);
      return { valid: true, roomId: room.id };
    }
    const token = secretSchema.parse(request.token);
    if (request.path === "action") return this.rooms.act(token, actionSchema.parse(request.data));
    const { room, member } = this.rooms.authenticate(token);
    if (request.path === "poll" && room.revision <= (request.after ?? 0)) {
      if (this.polls.has(member.id)) throw new HttpError(429, "poll-already-open");
      this.polls.add(member.id);
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.rooms.events.off(room.id, done);
          this.polls.delete(member.id);
          resolve();
        };
        const timer = setTimeout(done, 8000);
        this.rooms.events.once(room.id, done);
      });
      this.rooms.authenticate(token);
    }
    return { snapshot: this.rooms.snapshot(room) };
  }
  async request(
    peerId: string,
    request: WireRequest,
  ): Promise<Envelope | { valid: boolean; roomId: string }> {
    peerIdSchema.parse(peerId);
    wire.parse(request);
    let result: Envelope | { valid: boolean; roomId: string };
    if (peerId === this.peerId) result = await this.handle(request);
    else {
      let connection = this.connections.get(peerId);
      if (!connection || connection.closeReason() !== null) {
        connection = await timeout(
          this.endpoint.connect(
            this.resolver ? this.resolver(peerId) : new EndpointAddr(EndpointId.fromString(peerId)),
            ALPN,
          ),
          10000,
        );
        this.connections.set(peerId, connection);
      }
      const current = connection;
      try {
        const stream = await timeout(current.openBi(), 3000);
        await stream.send.writeAll(Array.from(Buffer.from(JSON.stringify(request))));
        await stream.send.finish();
        const bytes = await timeout(stream.recv.readToEnd(65536), 12000);
        const response = JSON.parse(Buffer.from(bytes).toString("utf8")) as WireResponse;
        if (response.status !== 200)
          throw new HttpError(
            response.status,
            "code" in response.result ? response.result.code : "peer-error",
          );
        result = response.result as Envelope;
      } catch (error) {
        if (!(error instanceof HttpError && error.status < 500)) {
          current.close(1n, []);
          this.connections.delete(peerId);
        }
        throw error;
      }
    }
    result = structuredClone(result);
    if ("session" in result && result.session) result.session.coordinator = peerId;
    if ("invite" in result && result.invite) result.invite = encodeCode(peerId, result.invite);
    return result;
  }
  async join(code: string, name: string) {
    const { peerId, invite } = decodeCode(code);
    return this.request(peerId, { path: "join", data: { invite, name } }) as Promise<Envelope>;
  }
  async validate(code: string) {
    const { peerId, invite } = decodeCode(code);
    return this.request(peerId, { path: "check", data: { invite } });
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const r of this.rooms.rooms.values()) this.rooms.close(r);
    for (const c of [...this.incoming, ...this.connections.values()]) c.close(0n, []);
    this.connections.clear();
    await this.endpoint.close();
  }
}
