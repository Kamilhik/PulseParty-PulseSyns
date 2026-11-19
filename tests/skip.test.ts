import test from "node:test";
import assert from "node:assert/strict";
import { Rooms } from "../server/rooms.js";
import { opId, RelayClient } from "../src/transport.js";
import { Synchronizer } from "../src/sync.js";
import { musicName } from "../src/identity.js";
import type { LocalPlayback, PlayerAdapter } from "../src/player-adapter.js";

test("profile nickname wins over account login, with a bounded login fallback", () => {
  assert.equal(musicName("account-login", { querySelector: () => ({ textContent: "  Kamilchik  " }) } as unknown as Document), "Kamilchik");
  assert.equal(musicName("account-login", { querySelector: () => null }), "account-login");
  assert.equal(musicName(undefined, { querySelector: () => null }), "Слушатель");
});

function setup() {
  let now = Date.now();
  const rooms = new Rooms({ now: () => now });
  const a = rooms.create("A").session!;
  const invitation = rooms.act(a.token, { type: "invite", profile: false, opId: opId() });
  const b = rooms.join(invitation.invite!, "B").session!;
  rooms.act(a.token, { type: "ready", epoch: 1, error: null, opId: opId() });
  return { rooms, a, b, advance: (ms: number) => { now += ms; } };
}

test("skip policy is enforced by the server and only the current host can acknowledge", () => {
  const { rooms, a, b } = setup();
  assert.throws(() => rooms.act(b.token, { type: "skip", direction: "next", opId: opId() }), /owner-only/);
  assert.throws(() => rooms.act(b.token, { type: "skipMode", mode: "everyone", opId: opId() }), /owner-only/);
  rooms.act(a.token, { type: "skipMode", mode: "everyone", opId: opId() });
  const command = { type: "skip" as const, direction: "next" as const, opId: opId() };
  const queued = rooms.act(b.token, command);
  assert.equal(queued.snapshot.skipQueue?.length, 1);
  assert.deepEqual(rooms.act(b.token, command), queued);
  const id = queued.snapshot.skipQueue![0].id;
  assert.throws(() => rooms.act(b.token, { type: "skipDone", id, epoch: 1, opId: opId() }), /stale-host/);
  assert.equal(rooms.act(a.token, { type: "skipDone", id, epoch: 1, opId: opId() }).snapshot.skipQueue?.length, 0);
  rooms.act(a.token, { type: "skipMode", mode: "owner", opId: opId() });
  assert.throws(() => rooms.act(b.token, { type: "skip", direction: "previous", opId: opId() }), /owner-only/);
});

test("pending skips cannot cross a handoff, survive expiry, or bypass a changed policy", () => {
  const { rooms, a, b, advance } = setup();
  const first = rooms.act(a.token, { type: "skip", direction: "next", opId: opId() });
  const handoff = rooms.act(a.token, { type: "handoff", targetId: b.memberId, opId: opId() });
  assert.equal(handoff.snapshot.skipQueue?.length, 0);
  assert.throws(() => rooms.act(a.token, { type: "skipDone", id: first.snapshot.skipQueue![0].id, epoch: 1, opId: opId() }), /stale-host/);
  rooms.act(b.token, { type: "ready", epoch: handoff.snapshot.epoch, error: null, opId: opId() });
  advance(300);
  rooms.act(a.token, { type: "skip", direction: "next", opId: opId() });
  advance(12_001);
  rooms.sweep();
  assert.equal(rooms.snapshot(rooms.authenticate(a.token).room).skipQueue?.length, 0);
});

test("a lost skip acknowledgement never executes the native queue action twice", async () => {
  const { rooms, a, b } = setup();
  rooms.act(a.token, { type: "skipMode", mode: "everyone", opId: opId() });
  const queued = rooms.act(b.token, { type: "skip", direction: "next", opId: opId() });
  const abort = new AbortController();
  let loseAck = true;
  const relay = new RelayClient("http://unused", async (_url, init) => {
    const action = JSON.parse(String(init?.body));
    if (action.type === "skipDone" && loseAck) { loseAck = false; throw new Error("Lost connection"); }
    return Response.json(rooms.act(a.token, action));
  }, abort.signal);
  relay.session = a;
  let calls = 0;
  let local: LocalPlayback = { track: null, playing: false, positionMs: 0, rate: 1, ready: true };
  const player: PlayerAdapter = {
    read: async () => ({ ...local }), load: async () => {}, seek: async () => {}, playing: async () => {},
    skip: async () => { calls++; local = { ...local, track: { trackId: "123", title: "A", artist: "B", cover: "", durationMs: 100000 } }; },
  };
  const sync = new Synchronizer(relay, player, { thresholdMs: 800, cooldownMs: 3000, seed: true, notice: () => assert.fail("No toasts"), status: () => {} });
  sync.accept(queued.snapshot);
  await assert.rejects(sync.step(abort.signal), /Lost connection/);
  await sync.step(abort.signal);
  assert.equal(calls, 1);
  assert.equal(rooms.snapshot(rooms.authenticate(a.token).room).skipQueue?.length, 0);
  abort.abort(); sync.stop();
});
