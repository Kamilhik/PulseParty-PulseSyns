import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { createCompanion } from "../companion/http.js";
import { PendingInvites } from "../companion/pending.js";
import type { DiscordWorker, Presence } from "../companion/native-worker.js";
import { Rooms } from "../server/rooms.js";
class Worker implements DiscordWorker {
  events = new EventEmitter();
  status = "Тестовый адаптер, не Discord";
  current: Presence | null = null;
  update(v: Presence) {
    this.current = v;
  }
  clear() {
    this.current = null;
  }
  stop() {
    this.clear();
  }
}
test("pending invites survive app loading, deduplicate, expire and reject arbitrary relays", () => {
  let now = 1000;
  const p = new PendingInvites("https://relay.test", () => now);
  const secret = randomBytes(32).toString("base64url");
  assert(p.add(secret));
  assert(!p.add(secret));
  assert.equal(p.peek()?.invite, secret);
  assert.throws(() => p.add("https://evil.test/invite#" + secret));
  p.ack(p.peek()!.id);
  assert.equal(p.peek(), null);
  assert(!p.add(secret));
  now += 180001;
  assert(p.add(secret));
  now += 180001;
  assert.equal(p.peek(), null);
});
test("real companion HTTP: pairing, Origin/Host, authorization, callback and clear", async () => {
  const worker = new Worker();
  const launchSecret = randomBytes(32).toString("base64url");
  const valid = randomBytes(32).toString("base64url");
  const bridge = createCompanion({
    relay: "https://relay.test",
    worker,
    launchSecret,
    validate: async (token) => {
      if (token !== valid) throw Error("invalid");
    },
  });
  bridge.server.listen(0, "127.0.0.1");
  await once(bridge.server, "listening");
  const url = "http://127.0.0.1:" + (bridge.server.address() as { port: number }).port;
  const origin = "https://addon-1001.pulsesync.invalid";
  const call = (route: string, data: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(url + "/v1/" + route, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...headers },
      body: JSON.stringify(data),
    });
  try {
    assert.equal(
      (await call("pair", { code: bridge.code }, { Origin: "https://evil.test" })).status,
      403,
    );
    const wrongHost = await new Promise<number>((resolve) => {
      const req = request(
        url + "/v1/status",
        {
          method: "POST",
          headers: { Host: "evil.test", Origin: origin, "Content-Type": "application/json" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.end("{}");
    });
    assert.equal(wrongHost, 403);
    assert.equal((await call("status")).status, 401);
    const pair = await call("pair", { code: bridge.code });
    assert.equal(pair.status, 200);
    const { token } = await pair.json();
    const headers = { Authorization: "Bearer " + token };
    assert.equal((await call("pair", { code: bridge.code })).status, 403);
    const status = await call("status", {}, headers);
    assert.equal(status.status, 200);
    worker.events.emit("join", valid);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal((await (await call("status", {}, headers)).json()).pending.invite, valid);
    const pending = bridge.pending.peek()!;
    await call("ack", { id: pending.id }, headers);
    assert.equal(bridge.pending.peek(), null);
    const rooms = new Rooms();
    const a = rooms.create("A");
    const response = await call(
      "presence",
      { snapshot: a.snapshot, memberId: a.session!.memberId, joinSecret: null },
      headers,
    );
    assert.equal(response.status, 200);
    assert.equal(worker.current?.joinSecret, "");
    await call("clear", {}, headers);
    assert.equal(worker.current, null);
    assert.equal(
      (
        await fetch(url + "/v1/launch", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + launchSecret },
          body: JSON.stringify({ invite: valid }),
        })
      ).status,
      200,
    );
    assert.equal(
      (await call("launch", { invite: valid }, { Authorization: "Bearer " + launchSecret })).status,
      403,
    );
  } finally {
    bridge.server.close();
    bridge.server.closeAllConnections();
  }
});
