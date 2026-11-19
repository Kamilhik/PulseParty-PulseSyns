import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { addonPlugin, defineAddonManifest } from "@pulsesync/addon-sdk/vite";
import config, { relayUrl, companionUrl } from "./addon.config.mjs";
import { settings } from "./src/settings.js";
export default defineConfig({
  define: {
    __RELAY_URL__: JSON.stringify(relayUrl),
    __COMPANION_URL__: JSON.stringify(companionUrl),
  },
  plugins: [react(), addonPlugin({ manifest: defineAddonManifest(config), settings })],
});
