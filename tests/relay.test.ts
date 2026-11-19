import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRelay } from "../server/http.js";
import { Rooms, HttpError } from "../server/rooms.js";
import { RelayClient, opId } from "../src/transport.js";
import {
  positionAt,
  parseInvite,
  actionSchema,
  type Session,
  type Playback,
} from "../shared/protocol.js";

export const music: Playback = {
  track: {
    trackId: "123",
    albumId: "10",
    title: "Песня",
    artist: "Исполнитель",
    durationMs: 180000,
    cover: "",
  },
  playing: true,
  positionMs: 12000,
  rate: 1,
};
const action = <T extends { type: string }>(v: T) => actionSchema.parse({ ...v, opId: opId() });
test("three real HTTP clients: play, pause, seek, repeat, handoff and ownership", async () => {
  const { server } = createRelay();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const abort = new AbortController();
  const clients = [0, 1, 2].map(() => new RelayClient(url, fetch, abort.signal));
  const [a, b, c] = clients;
  try {
    const created = await a.call("rooms", { name: "Анна" });
    a.session = created.session!;
    const invite = await a.action(action({ type: "invite", profile: false }));
    b.session = (await b.call("join", { name: "Борис", invite: invite.invite })).session!;
    c.session = (await c.call("join", { name: "Вера", invite: invite.invite })).session!;
    await a.action(action({ type: "ready", epoch: 1, error: null }));
    const playing = await a.action(
      action({ type: "publish", epoch: 1, sequence: 1, playback: music, sampledAt: a.now() }),
    );
    assert.equal((await b.call("snapshot")).snapshot.playback.track?.trackId, "123");
    const pending = c.call("poll?after=" + playing.snapshot.revision);
    const paused = await a.action(
      action({
        type: "publish",
        epoch: 1,
        sequence: 2,
        playback: { ...music, playing: false, positionMs: 40000 },
        sampledAt: a.now(),
      }),
    );
    assert.equal((await pending).snapshot.playback.playing, false);
    assert.equal(positionAt(paused.snapshot.playback, a.now() + 60000), 40000);
    await assert.rejects(
      b.action(
        action({ type: "publish", epoch: 1, sequence: 3, playback: music, sampledAt: b.now() }),
      ),
      /stale-host/,
    );
    for (const next of [b, c, a, b, a]) {
      const current = (await a.call("snapshot")).snapshot;
      const leader = clients.find((x) => x.session?.memberId === current.hostId)!;
      const handoff = await leader.action(
        action({ type: "handoff", targetId: next.session!.memberId }),
      );
      assert.equal(handoff.snapshot.ownerId, a.session.memberId);
      await assert.rejects(
        leader.action(
          action({
            type: "publish",
            epoch: current.epoch,
            sequence: 99,
            playback: music,
            sampledAt: leader.now(),
          }),
        ),
        /stale-host/,
      );
      // Every new leader acknowledges the current room state before publication.
      await next.action(action({ type: "ready", epoch: handoff.snapshot.epoch, error: null }));
      const published = await next.action(
        action({
          type: "publish",
          epoch: handoff.snapshot.epoch,
          sequence: 1,
          playback: { ...music, positionMs: 1000 },
          sampledAt: next.now(),
        }),
      );
      assert.equal(published.snapshot.sequence, 1);
    }
    await assert.rejects(b.action(action({ type: "close" })), /owner-only/);
    await b.action(action({ type: "request" }));
    await a.action(action({ type: "decide", targetId: b.session.memberId, accept: false }));
    await assert.rejects(a.action(action({ type: "leave" })), /transfer-owner-or-close/);
    await a.action(action({ type: "transferOwner", targetId: c.session.memberId }));
    await a.action(action({ type: "leave" }));
    await c.action(action({ type: "close" }));
    await assert.rejects(b.call("snapshot"), /session-expired/);
  } finally {
    abort.abort();
    server.close();
    server.closeAllConnections();
  }
});
test("server rejects replayed/out-of-order publications and deduplicates handoffs", () => {
  const rooms = new Rooms();
  const a = rooms.create("A");
  const token = a.session!.token;
  const invite = rooms.act(token, action({ type: "invite", profile: false }));
  const b = rooms.join(invite.invite!, "B");
  rooms.act(token, action({ type: "ready", epoch: 1, error: null }));
  const publish = action({
    type: "publish",
    epoch: 1,
    sequence: 1,
    playback: music,
    sampledAt: Date.now(),
  });
  const first = rooms.act(token, publish);
  assert.deepEqual(rooms.act(token, publish), first);
  assert.throws(
    () =>
      rooms.act(token, { ...publish, playback: { ...music, positionMs: 500 } } as typeof publish),
    /op-conflict/,
  );
  assert.throws(
    () =>
      rooms.act(
        token,
        action({ type: "publish", epoch: 1, sequence: 1, playback: music, sampledAt: Date.now() }),
      ),
    /stale-sequence/,
  );
  const transfer = action({ type: "handoff", targetId: b.session!.memberId });
  const h = rooms.act(token, transfer);
  assert.equal(rooms.act(token, transfer).snapshot.epoch, h.snapshot.epoch);
  assert.throws(
    () =>
      rooms.act(
        b.session!.token,
        action({
          type: "publish",
          epoch: h.snapshot.epoch,
          sequence: 1,
          playback: music,
          sampledAt: Date.now(),
        }),
      ),
    /stale-host/,
  );
});
test("invite expiry, revocation, kicking, full room and private profile", () => {
  let now = 100000;
  const rooms = new Rooms({ maxSize: 2, now: () => now, inviteTtlMs: 1000 });
  const a = rooms.create("A");
  const token = a.session!.token;
  assert.throws(
    () => rooms.act(token, action({ type: "invite", profile: true })),
    /profile-closed/,
  );
  const invite = rooms.act(token, action({ type: "invite", profile: false }));
  const b = rooms.join(invite.invite!, "B");
  assert.throws(() => rooms.join(invite.invite!, "C"), /room-full/);
  rooms.act(token, action({ type: "kick", targetId: b.session!.memberId, revokeInvites: true }));
  assert.throws(() => rooms.authenticate(b.session!.token), /session-expired/);
  assert.throws(() => rooms.join(invite.invite!, "B"), /invite-expired/);
  const fresh = rooms.act(token, action({ type: "invite", profile: false }));
  now += 1001;
  assert.throws(() => rooms.join(fresh.invite!, "B"), /invite-expired/);
});
test("grace period failover preserves owner; reconnect restores epoch and sequence", () => {
  let now = 100000;
  const rooms = new Rooms({ now: () => now, graceMs: 2000 });
  const a = rooms.create("A");
  const invite = rooms.act(a.session!.token, action({ type: "invite", profile: false }));
  const b = rooms.join(invite.invite!, "B");
  rooms.act(a.session!.token, action({ type: "ready", epoch: 1, error: null }));
  now += 1500;
  rooms.authenticate(b.session!.token);
  rooms.sweep();
  assert.equal(rooms.snapshot(rooms.rooms.values().next().value!).hostId, a.session!.memberId);
  now += 600;
  rooms.sweep();
  const resumed = rooms.authenticate(a.session!.token);
  const s = rooms.snapshot(resumed.room);
  assert.equal(s.hostId, b.session!.memberId);
  assert.equal(s.ownerId, a.session!.memberId);
  assert.equal(s.epoch, 2);
  assert.equal(s.sequence, 0);
  assert.throws(
    () =>
      rooms.act(
        a.session!.token,
        action({ type: "publish", epoch: 1, sequence: 10, playback: music, sampledAt: now }),
      ),
    /stale-host/,
  );
});
test("stale clocks, invalid positions, schema bounds and unsupported URLs", () => {
  const rooms = new Rooms();
  const a = rooms.create("A");
  rooms.act(a.session!.token, action({ type: "ready", epoch: 1, error: null }));
  assert.throws(
    () =>
      rooms.act(
        a.session!.token,
        action({
          type: "publish",
          epoch: 1,
          sequence: 1,
          playback: music,
          sampledAt: Date.now() - 20000,
        }),
      ),
    /stale-sample/,
  );
  assert.throws(
    () =>
      rooms.act(
        a.session!.token,
        action({
          type: "publish",
          epoch: 1,
          sequence: 1,
          playback: { ...music, positionMs: 999999 },
          sampledAt: Date.now(),
        }),
      ),
    /invalid-position/,
  );
  assert.throws(() =>
    action({
      type: "publish",
      epoch: 1,
      sequence: 1,
      playback: { ...music, rate: 2 },
      sampledAt: Date.now(),
    }),
  );
  assert.throws(() =>
    parseInvite("https://evil.test/invite#" + "a".repeat(43), "https://relay.test"),
  );
  assert.throws(() =>
    parseInvite("http://127.0.0.1/invite#" + "a".repeat(43), "https://relay.test"),
  );
  assert.equal(
    parseInvite("pulseparty://join#" + "a".repeat(43), "https://relay.test"),
    "a".repeat(43),
  );
});
test("HTTP validates Origin, body, content type; invite page has no cache/referrers", async () => {
  const { server } = createRelay();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  try {
    assert.equal(
      (
        await fetch(url + "/v1/rooms", {
          method: "POST",
          headers: { Origin: "https://evil.test", "Content-Type": "application/json" },
          body: '{"name":"A"}',
        })
      ).status,
      403,
    );
    assert.equal((await fetch(url + "/v1/rooms", { method: "POST", body: "{}" })).status, 415);
    assert.equal(
      (
        await fetch(url + "/v1/rooms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "x".repeat(17000) }),
        })
      ).status,
      413,
    );
    const page = await fetch(url + "/invite");
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("Cache-Control"), "no-store");
    assert.equal(page.headers.get("Referrer-Policy"), "no-referrer");
    const html = await page.text();
    assert.match(html, /Скопировать код/);
    assert.doesNotMatch(html, /pulseparty:\/\//);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
