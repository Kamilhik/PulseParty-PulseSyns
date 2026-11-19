import test from "node:test";
import assert from "node:assert/strict";
import { Endpoint, presetMinimal } from "@number0/iroh";
import { once, EventEmitter } from "node:events";
import { IrohNetwork } from "../host/iroh-network.js";
import { createEmbeddedGateway } from "../host/gateway.js";
import { decodeCode } from "../shared/iroh-code.js";
import { opId, RelayClient } from "../src/transport.js";
import type { Envelope } from "../shared/protocol.js";
import type { DiscordWorker } from "../companion/native-worker.js";
async function nativePeers(count: number) {
  const endpoints: Endpoint[] = [];
  for (let i = 0; i < count; i++) {
    const b = Endpoint.builder();
    presetMinimal(b);
    b.bindAddr("127.0.0.1:0");
    endpoints.push(await b.bind());
  }
  const networks = await Promise.all(
    endpoints.map((endpoint) =>
      IrohNetwork.start({
        endpoint,
        resolver: (id) => endpoints.find((e) => e.id().toString() === id)!.addr(),
      }),
    ),
  );
  return networks;
}
test("three real native iroh endpoints: encrypted QUIC streams, room invitation, host handoff and replay", async () => {
  const [a, b, c] = await nativePeers(3);
  try {
    const created = a.create("Анна");
    const owner = created.session!;
    const invite = (await a.request(a.peerId, {
      path: "action",
      token: owner.token,
      data: { type: "invite", profile: false, opId: opId() },
    })) as Envelope;
    const originalOp = { type: "invite", profile: false, opId: opId() };
    const once = (await a.request(a.peerId, {
      path: "action",
      token: owner.token,
      data: originalOp,
    })) as Envelope;
    const twice = (await a.request(a.peerId, {
      path: "action",
      token: owner.token,
      data: originalOp,
    })) as Envelope;
    assert.equal(once.invite, twice.invite);
    assert.equal(decodeCode(invite.invite!).peerId, a.peerId);
    const joined = await b.join(invite.invite!, "Борис");
    const third = await c.join(invite.invite!, "Вера");
    assert.equal(joined.session!.coordinator, a.peerId);
    assert.equal(third.snapshot.members.length, 3);
    await a.request(a.peerId, {
      path: "action",
      token: owner.token,
      data: { type: "ready", epoch: 1, error: null, opId: opId() },
    });
    const playback = {
      track: { trackId: "123", title: "Трек", artist: "Артист", cover: "", durationMs: 120000 },
      playing: true,
      positionMs: 1000,
      rate: 1,
    };
    await a.request(a.peerId, {
      path: "action",
      token: owner.token,
      data: {
        type: "publish",
        epoch: 1,
        sequence: 1,
        playback,
        sampledAt: Date.now(),
        opId: opId(),
      },
    });
    const snapshot = (await c.request(a.peerId, {
      path: "snapshot",
      token: third.session!.token,
    })) as Envelope;
    assert.equal(snapshot.snapshot.playback.track?.trackId, "123");
    const poll = c.request(a.peerId, {
      path: "poll",
      token: third.session!.token,
      after: snapshot.snapshot.revision,
    });
    const handoff = (await b.request(a.peerId, {
      path: "action",
      token: owner.token,
      data: { type: "handoff", targetId: joined.session!.memberId, opId: opId() },
    })) as Envelope;
    assert.equal(((await poll) as Envelope).snapshot.hostId, joined.session!.memberId);
    assert.equal(handoff.snapshot.epoch, 2);
    await assert.rejects(
      a.request(a.peerId, {
        path: "action",
        token: owner.token,
        data: {
          type: "publish",
          epoch: 1,
          sequence: 2,
          playback,
          sampledAt: Date.now(),
          opId: opId(),
        },
      }),
      /stale-host/,
    );
    await b.request(a.peerId, {
      path: "action",
      token: joined.session!.token,
      data: { type: "ready", epoch: 2, error: null, opId: opId() },
    });
    await b.request(a.peerId, {
      path: "action",
      token: joined.session!.token,
      data: {
        type: "publish",
        epoch: 2,
        sequence: 1,
        playback: { ...playback, track: { ...playback.track, trackId: "456" } },
        sampledAt: Date.now(),
        opId: opId(),
      },
    });
    assert.equal(
      ((await c.request(a.peerId, { path: "snapshot", token: third.session!.token })) as Envelope)
        .snapshot.playback.track?.trackId,
      "456",
    );
    await a.request(a.peerId, {
      path: "action",
      token: owner.token,
      data: { type: "revokeInvites", opId: opId() },
    });
    await assert.rejects(c.validate(invite.invite!), /invite-expired/);
  } finally {
    await Promise.all([a, b, c].map((n) => n.stop()));
  }
});
test("embedded gateway requires host capability and uses native iroh without a room server", async () => {
  const [network] = await nativePeers(1);
  const worker: DiscordWorker = {
    events: new EventEmitter(),
    status: "Тестовый RPC адаптер",
    update() {},
    clear() {},
    stop() {},
  };
  const token = "a".repeat(43);
  const gateway = createEmbeddedGateway({
    network,
    worker,
    bridgeToken: token,
    rpcDisabled: () => false,
  });
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const origin = "http://127.0.0.1:" + (gateway.server.address() as { port: number }).port;
  const headers = { Origin: "https://addon-1001.pulsesync.invalid", "X-PulseParty-Bridge": token };
  const fetcher = (url: string, init?: RequestInit) =>
    fetch(url, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers },
    });
  const abort = new AbortController();
  const client = new RelayClient(origin, fetcher, abort.signal);
  try {
    assert.equal(
      (
        await fetch(origin + "/v1/status", {
          method: "POST",
          headers: { Origin: headers.Origin, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    const room = await client.call("rooms", { name: "Анна" });
    client.session = room.session!;
    assert.equal((await client.call("snapshot")).snapshot.roomId, room.snapshot.roomId);
    assert.equal(
      (
        await fetcher(origin + "/v1/configure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ applicationId: "123456789012345678" }),
        })
      ).status,
      409,
    );
  } finally {
    abort.abort();
    gateway.server.close();
    gateway.server.closeAllConnections();
    await network.stop();
  }
});
