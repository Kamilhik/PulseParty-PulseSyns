import test from "node:test";
import assert from "node:assert/strict";
import { Rooms } from "../server/rooms.js";
import { Synchronizer } from "../src/sync.js";
import { RelayClient, opId } from "../src/transport.js";
import { fromSnapshot, type PlayerAdapter, type LocalPlayback } from "../src/player-adapter.js";
import type { Snapshot, Track, Playback } from "../shared/protocol.js";
const track: Track = {
  trackId: "123",
  albumId: "1",
  title: "Трек",
  artist: "Артист",
  cover: "",
  durationMs: 180000,
};
class Player implements PlayerAdapter {
  local: LocalPlayback = { track: null, playing: false, positionMs: 0, rate: 1, ready: true };
  calls: string[] = [];
  volume = 42;
  loadDelay = 0;
  unavailable = false;
  async read() {
    return { ...this.local };
  }
  async load(t: Track) {
    this.calls.push("load:" + t.trackId);
    this.local.ready = false;
    if (this.loadDelay) await new Promise((r) => setTimeout(r, this.loadDelay));
    if (!this.unavailable) this.local = { ...this.local, track: t, ready: true, positionMs: 0 };
  }
  async seek(ms: number) {
    assert(this.local.ready);
    this.calls.push("seek:" + this.local.track?.trackId);
    this.local.positionMs = ms;
  }
  async playing(value: boolean) {
    this.calls.push("playing:" + value);
    this.local.playing = value;
  }
}
function setup() {
  const rooms = new Rooms();
  const a = rooms.create("A");
  const invite = rooms.act(a.session!.token, { type: "invite", profile: false, opId: opId() });
  const b = rooms.join(invite.invite!, "B");
  rooms.act(a.session!.token, { type: "ready", epoch: 1, error: null, opId: opId() });
  const s = rooms.act(a.session!.token, {
    type: "publish",
    epoch: 1,
    sequence: 1,
    playback: { track, playing: true, positionMs: 12000, rate: 1 },
    sampledAt: Date.now(),
    opId: opId(),
  }).snapshot;
  const abort = new AbortController();
  const relay = new RelayClient(
    "http://unused",
    async (url, init) => {
      const result = rooms.act(relay.session!.token, JSON.parse(String(init!.body)));
      return new Response(JSON.stringify(result), { status: 200 });
    },
    abort.signal,
  );
  relay.session = b.session!;
  const player = new Player();
  const notices: string[] = [];
  const sync = new Synchronizer(relay, player, {
    thresholdMs: 800,
    cooldownMs: 3000,
    loadTimeoutMs: 100,
    notice: (t) => notices.push(t),
    status: () => {},
  });
  sync.accept(s);
  return { rooms, a, b, s, abort, relay, player, notices, sync };
}
test("adapter isolates seconds/milliseconds and does not include volume", () => {
  const p = fromSnapshot({
    status: "playing",
    isPlaying: true,
    track: { id: "123", title: "A", duration: 180000, artists: [{ id: "1", name: "B" }] },
    duration: 180000,
    progress: { position: 12.5 },
    volume: 42,
    repeatMode: null,
    shuffle: false,
  });
  assert.equal(p.positionMs, 12500);
  assert.equal(p.track?.durationMs, 180000);
  assert.equal("volume" in p, false);
});
test("async track loading completes before seek; follower never publishes or changes volume", async () => {
  const x = setup();
  x.player.loadDelay = 80;
  await x.sync.step(x.abort.signal);
  assert.deepEqual(x.player.calls.slice(0, 2), ["load:123", "seek:123"]);
  assert.equal(x.player.volume, 42);
  assert.equal(x.rooms.snapshot(x.rooms.authenticate(x.a.session!.token).room).sequence, 1);
  assert.equal(x.player.local.playing, true);
});
test("threshold and cooldown avoid repeated seeks; listener local pause is restored", async () => {
  const x = setup();
  await x.sync.step(x.abort.signal);
  const count = x.player.calls.filter((s) => s.startsWith("seek")).length;
  x.player.local.positionMs += 300;
  await x.sync.step(x.abort.signal);
  assert.equal(x.player.calls.filter((s) => s.startsWith("seek")).length, count);
  x.player.local.playing = false;
  await x.sync.step(x.abort.signal);
  assert.equal(x.player.local.playing, true);
  assert.equal(x.notices.length, 0);
});
test("handoff adopts room track before a new host publishes its old local track", async () => {
  const x = setup();
  const s = x.rooms.act(x.a.session!.token, {
    type: "handoff",
    targetId: x.b.session!.memberId,
    opId: opId(),
  }).snapshot;
  x.player.local = {
    track: { ...track, trackId: "999" },
    playing: true,
    positionMs: 100,
    rate: 1,
    ready: true,
  };
  x.sync.accept(s);
  await x.sync.step(x.abort.signal);
  const final = x.rooms.snapshot(x.rooms.authenticate(x.a.session!.token).room);
  assert.equal(final.playback.track?.trackId, "123");
  assert.equal(final.hostReady, true);
  assert.equal(final.sequence, 1);
});
test("cancelled epoch never seeks or acknowledges an obsolete async track", async () => {
  const x = setup();
  x.player.loadDelay = 100;
  const pending = x.sync.step(x.abort.signal);
  await new Promise((r) => setTimeout(r, 20));
  x.sync.accept({
    ...x.s,
    revision: x.s.revision + 1,
    epoch: 2,
    playback: { ...x.s.playback, track: { ...track, trackId: "456" } },
  });
  await pending;
  assert.equal(
    x.player.calls.some((s) => s.startsWith("seek")),
    false,
  );
});
test("stop cancels asynchronous synchronization without feedback or unhandled rejection", async () => {
  const x = setup();
  x.player.loadDelay = 100;
  const pending = x.sync.step(x.abort.signal);
  await new Promise((r) => setTimeout(r, 20));
  x.sync.stop();
  x.abort.abort();
  await pending;
  assert.equal(
    x.player.calls.some((s) => s.startsWith("seek")),
    false,
  );
});
test("local no-music state pauses follower without unloading or changing volume", async () => {
  const x = setup();
  x.player.local = { ...x.player.local, track, playing: true };
  x.sync.accept({
    ...x.s,
    revision: x.s.revision + 1,
    playback: { track: null, playing: false, positionMs: 0, rate: 1, at: Date.now() },
  });
  await x.sync.step(x.abort.signal);
  assert.equal(x.player.local.playing, false);
  assert.equal(x.player.volume, 42);
});
test("unavailable track is local; next song can synchronize", async () => {
  const x = setup();
  x.player.unavailable = true;
  await x.sync.step(x.abort.signal);
  assert.equal(
    x.player.calls.some((c) => c.startsWith("seek")),
    false,
  );
  let s = x.rooms.snapshot(x.rooms.authenticate(x.a.session!.token).room);
  assert.equal(s.playback.playing, true);
  assert.equal(s.members.find((m) => m.id === x.b.session!.memberId)?.error, "track-unavailable");
  x.player.unavailable = false;
  s = x.rooms.act(x.a.session!.token, {
    type: "publish",
    epoch: 1,
    sequence: 2,
    playback: { track: { ...track, trackId: "456" }, playing: true, positionMs: 0, rate: 1 },
    sampledAt: Date.now(),
    opId: opId(),
  }).snapshot;
  x.sync.accept(s);
  await x.sync.step(x.abort.signal);
  assert.equal(x.player.local.track?.trackId, "456");
  assert.equal(
    x.rooms
      .snapshot(x.rooms.authenticate(x.a.session!.token).room)
      .members.find((m) => m.id === x.b.session!.memberId)?.error,
    null,
  );
});
test("same host reconnects after grace without getting stuck on hostReady=false", async () => {
  const x = setup();
  const host = x.rooms.act(x.a.session!.token, {
    type: "handoff",
    targetId: x.b.session!.memberId,
    opId: opId(),
  }).snapshot;
  x.sync.accept(host);
  await x.sync.step(x.abort.signal);
  x.rooms.act(x.b.session!.token, {
    type: "ready",
    epoch: host.epoch,
    error: "offline",
    opId: opId(),
  });
  const resume = x.rooms.snapshot(x.rooms.authenticate(x.b.session!.token).room);
  assert.equal(resume.hostReady, false);
  x.sync.accept(resume);
  await x.sync.step(x.abort.signal);
  assert.equal(x.rooms.snapshot(x.rooms.authenticate(x.b.session!.token).room).hostReady, true);
});
test("pause/seek received during async loading uses the newest room anchor", async () => {
  const x = setup();
  x.player.loadDelay = 100;
  const pending = x.sync.step(x.abort.signal);
  await new Promise((r) => setTimeout(r, 20));
  const latest = x.rooms.act(x.a.session!.token, {
    type: "publish",
    epoch: 1,
    sequence: 2,
    playback: { track, playing: false, positionMs: 55000, rate: 1 },
    sampledAt: Date.now(),
    opId: opId(),
  }).snapshot;
  x.sync.accept(latest);
  await pending;
  assert.equal(x.player.local.playing, false);
  assert.equal(x.player.local.positionMs, 55000);
});
