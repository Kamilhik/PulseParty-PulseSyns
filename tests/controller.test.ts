import test from "node:test";
import assert from "node:assert/strict";
import type { AddonApi } from "@pulsesync/addon-sdk";
import { PartyController } from "../src/controller.js";
test("missing embedded host reports a setup state without sending a doomed network request", async () => {
  let calls = 0;
  const api = {
    modSettings: { get: async () => undefined },
    net: {
      fetch: async () => {
        calls++;
        throw new TypeError("Failed to fetch");
      },
    },
  } as unknown as AddonApi;
  const controller = new PartyController(api, "http://127.0.0.1:18787", "http://127.0.0.1:18787");
  await controller.checkHost();
  assert.equal(controller.get().hostStatus, "missing");
  await controller.perform(() => controller.create());
  assert.match(controller.get().error, /встроенный модуль/);
  assert.equal(calls, 0);
  controller.dispose();
});
test("an unavailable embedded host is distinct from a missing one and can be retried", async () => {
  let reachable = false;
  const api = {
    modSettings: { get: async () => "a".repeat(43) },
    net: {
      fetch: async () => {
        if (!reachable) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ discord: "Off", pending: null }), { status: 200 });
      },
    },
  } as unknown as AddonApi;
  const controller = new PartyController(api, "http://127.0.0.1:18787", "http://127.0.0.1:18787");
  await controller.checkHost();
  assert.equal(controller.get().hostStatus, "unavailable");
  reachable = true;
  await controller.checkHost();
  assert.equal(controller.get().hostStatus, "ready");
  controller.dispose();
});
test("stock PulseSync does not require a native token and checks the configured service", async () => {
  const urls: string[] = [];
  const api = { net: { fetch: async (url: string) => {
    urls.push(url);
    return Response.json({ ok: true, protocol: 1 });
  } } } as unknown as AddonApi;
  const controller = new PartyController(api, "https://rooms.example", "");
  await controller.checkHost();
  assert.equal(controller.integrated, false);
  assert.equal(controller.get().hostStatus, "ready");
  assert.deepEqual(urls, ["https://rooms.example/v1/health"]);
  await assert.rejects(controller.setDiscord(true), /Discord IPC/);
  controller.dispose();
});
test("an unconfigured stock build never fetches a relative URL or localhost", async () => {
  let calls = 0;
  const api = { net: { fetch: async () => { calls++; throw new Error("must not fetch"); } } } as unknown as AddonApi;
  const controller = new PartyController(api, "", "");
  await controller.checkHost();
  assert.equal(controller.get().hostStatus, "unconfigured");
  await controller.perform(() => controller.create());
  assert.match(controller.get().error, /адрес сервиса/);
  assert.equal(calls, 0);
  controller.dispose();
});
