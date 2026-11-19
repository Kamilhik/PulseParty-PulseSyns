import { defineAddon, type AddonApi } from "@pulsesync/addon-sdk";
import { PartyController } from "./controller.js";
import { PartyOverlay } from "./overlay.js";
import { PartyLauncher } from "./launcher.js";
import { FallbackLauncher } from "./fallback-launcher.js";
import { activateParty } from "./activation.js";
import { WAVE_MOUNT_SELECTOR, FULLSCREEN_MOUNT_SELECTOR } from "./placement.js";
import { settings } from "./settings.js";
import "./style.css";
let party: PartyController | undefined;
let modalOpen = false;
async function openParty(api: AddonApi) {
  const controller = party;
  if (!controller || modalOpen) return;
  modalOpen = true;
  try {
    await api.modals.open((props) => (
      <PartyOverlay controller={controller} close={() => props.controller.close()} />
    ));
  } finally {
    modalOpen = false;
  }
}
export default defineAddon({
  id: "pulseparty",
  name: "PulseParty",
  settings,
  start: (api) => {
    party = activateParty(
      api,
      __RELAY_URL__,
      __COMPANION_URL__,
      settings.store.thresholdMs,
      settings.store.cooldownMs,
      () => { party = undefined; },
    );
  },
  slots: {
    playerBarButton: function PartyButton({ api }) {
      if (!party) return null;
      return <PartyLauncher open={() => openParty(api)} />;
    },
  },
  mounts: [
    {
      target: "body",
      component: ({ api }) => <FallbackLauncher open={() => openParty(api)} />,
    },
    {
      target: { selector: WAVE_MOUNT_SELECTOR, all: true },
      component: ({ api }) => <PartyLauncher placement="wave" open={() => openParty(api)} />,
    },
    {
      target: { selector: FULLSCREEN_MOUNT_SELECTOR, all: true },
      component: ({ api }) => <PartyLauncher placement="fullscreen" open={() => openParty(api)} />,
    },
  ],
});
