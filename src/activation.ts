import type { AddonApi } from "@pulsesync/addon-sdk";
import { PartyController } from "./controller.js";

/** Network and profile availability must never gate addon UI registration. */
export function activateParty(
  api: AddonApi,
  relayUrl: string,
  companionUrl: string,
  thresholdMs: number,
  cooldownMs: number,
  cleanup: () => void,
): PartyController {
  const controller = new PartyController(api, relayUrl, companionUrl, thresholdMs, cooldownMs);
  api.onCleanup(() => { controller.dispose(); cleanup(); });
  void controller.start().catch(error => controller.initializationFailed(error));
  return controller;
}
