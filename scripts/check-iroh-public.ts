import { IrohNetwork } from "../host/iroh-network.js";
import { opId } from "../src/transport.js";
import type { Envelope } from "../shared/protocol.js";
const peers: IrohNetwork[] = [];
function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("public-network-timeout")), ms);
    p.then(
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
try {
  peers.push(await IrohNetwork.start(), await IrohNetwork.start());
  await timeout(Promise.all(peers.map((p) => p.endpoint.online())), 20000);
  const [a, b] = peers;
  const room = a.create("Проверка");
  const issued = (await a.request(a.peerId, {
    path: "action",
    token: room.session!.token,
    data: { type: "invite", profile: false, opId: opId() },
  })) as Envelope;
  const start = Date.now();
  const joined = await b.join(issued.invite!, "Второй endpoint");
  const elapsed = Date.now() - start;
  if (joined.snapshot.members.length !== 2) throw Error("membership-mismatch");
  console.log(
    JSON.stringify({
      ok: true,
      defaultN0Preset: true,
      online: true,
      joinedOverEndpointLookup: true,
      joinMs: elapsed,
      sameMachine: true,
      note: "Public discovery/relay bootstrap tested; cross-NAT and relay-only path not established by this test.",
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      defaultN0Preset: true,
      error: error instanceof Error ? error.message : "unknown",
    }),
  );
  process.exitCode = 1;
} finally {
  await Promise.all(peers.map((p) => p.stop()));
}
