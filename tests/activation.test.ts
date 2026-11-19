import test from "node:test";
import assert from "node:assert/strict";
import type { AddonApi } from "@pulsesync/addon-sdk";
import { activateParty } from "../src/activation.js";

test("addon UI activation completes while the room service is still pending", async () => {
  let cleanup: (() => void) | undefined;
  let healthStarted = false;
  let resolveHealth!: (response: Response) => void;
  const health = new Promise<Response>(resolve => { resolveHealth = resolve; });
  const api = {
    onCleanup: (fn: () => void) => { cleanup = fn; },
    user: { getLogin: async () => "listener" },
    storage: { get: async () => undefined, remove: async () => {} },
    net: { fetch: () => { healthStarted = true; return health; } },
  } as unknown as AddonApi;
  let disposed = false;
  const controller = activateParty(api, "https://rooms.example", "", 800, 3000, () => { disposed = true; });
  assert.equal(controller.get().hostStatus, "checking");
  assert.equal(typeof (controller as unknown as { then?: unknown }).then, "undefined");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(healthStarted, true);
  assert.equal(controller.get().hostStatus, "checking");
  resolveHealth(Response.json({ ok: true, protocol: 1 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.get().hostStatus, "ready");
  cleanup!();
  assert.equal(disposed, true);
});

test("profile bridge failure is shown inside the addon instead of rejecting activation", async () => {
  let cleanup: (() => void) | undefined;
  const api = {
    onCleanup: (fn: () => void) => { cleanup = fn; },
    user: { getLogin: async () => { throw new Error("Профиль временно недоступен"); } },
  } as unknown as AddonApi;
  const controller = activateParty(api, "https://rooms.example", "", 800, 3000, () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.get().hostStatus, "unavailable");
  assert.match(controller.get().error, /Профиль временно недоступен/);
  cleanup!();
});
