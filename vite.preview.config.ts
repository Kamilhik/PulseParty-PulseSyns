import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "preview",
  server: { port: 5173, strictPort: true },
  plugins: [react()],
  resolve: { alias: { "@pulsesync/addon-sdk": path.resolve("preview/sdk.tsx") } },
});
