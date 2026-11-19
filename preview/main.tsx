import React from "react";
import { createRoot } from "react-dom/client";
import type { AddonApi } from "@pulsesync/addon-sdk";
import { PartyController } from "../src/controller.js";
import { PartyOverlay } from "../src/overlay.js";
import { PartyLauncher } from "../src/launcher.js";
import "../src/style.css";
const store = new Map();
let player: any = {
  status: "paused",
  isPlaying: false,
  track: null,
  progress: { position: 0 },
  duration: 0,
  volume: 42,
  repeatMode: null,
  shuffle: false,
};
let at = Date.now();
const playerListeners = new Set<(snapshot: any) => void>();
const notifyPlayer = () => { const snapshot = sample(); for (const listener of playerListeners) listener(snapshot); };
const sample = () => {
  const now = Date.now();
  if (player.isPlaying) player.progress.position += (now - at) / 1000;
  at = now;
  return structuredClone(player);
};
const embedded = (window as unknown as { __PREVIEW_BRIDGE__?: { url: string; token: string } })
  .__PREVIEW_BRIDGE__;
const relay = (window as unknown as { __PREVIEW_RELAY_URL__?: string }).__PREVIEW_RELAY_URL__;
const api = {
  net: { fetch: (url: string, init: RequestInit) => fetch(url, init) },
  storage: {
    get: async (key: string) => store.get(key),
    set: async (key: string, v: unknown) => {
      store.set(key, v);
    },
    remove: async (key: string) => {
      store.delete(key);
    },
  },
  user: { getLogin: async () => (window as unknown as { __PREVIEW_USER__?: string }).__PREVIEW_USER__ ?? "preview-user" },
  modSettings: {
    get: async (key: string) =>
      key === "modSettings.pulseParty.bridgeToken" ? embedded?.token : false,
  },
  notifications: {
    info: async (text: string) => {
      document.getElementById("notice")!.textContent = text;
    },
  },
  player: {
    getSnapshot: async () => sample(),
    onChange: (listener: (snapshot: any) => void) => { playerListeners.add(listener); return () => { playerListeners.delete(listener); }; },
  },
  client: {
    playTrackById: async (id: string) => {
      sample();
      player.track = {
        id,
        title: id === "123" ? "Тёплый вечер" : "Вторая песня",
        duration: 180000,
        artists: [{ id: "1", name: "Тестовый исполнитель" }],
        albums: [{ id: "10" }],
      };
      player.status = "playing";
      player.isPlaying = true;
      player.progress.position = 0;
      notifyPlayer();
    },
    setProgress: async (value: number) => {
      sample();
      player.progress.position = value;
      notifyPlayer();
    },
    togglePlayPause: async () => {
      sample();
      player.isPlaying = !player.isPlaying;
      player.status = player.isPlaying ? "playing" : "paused";
      notifyPlayer();
    },
    next: async () => api.client.playTrackById(player.track?.id === "123" ? "456" : "123"),
    previous: async () => api.client.playTrackById(player.track?.id === "123" ? "456" : "123"),
  },
} as unknown as AddonApi;
const party = new PartyController(
  api,
  embedded?.url ?? relay ?? "http://127.0.0.1:8787",
  embedded?.url ?? "",
);
await party.start();
Object.assign(window, {
  party,
  previewPlayer: {
    load: (id: string) => api.client.playTrackById(id),
    toggle: () => api.client.togglePlayPause(),
  },
});
document.body.style.cssText = "margin:0;background:#111210;color:#e8e7df;font:14px Arial;";
function PreviewApp() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <aside
        style={{
          padding: "12px 24px",
          fontSize: 12,
          color: "#aaa",
          borderBottom: "1px solid #ffffff14",
        }}
      >
        Тестовый стенд · настоящий iroh, тестовые плеер и Discord · без звука
      </aside>
      <main
        style={{ padding: "48px 24px", minHeight: "calc(100vh - 126px)", background: "#101010" }}
      >
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <div style={{ fontSize: 14, color: "#aaa", marginBottom: 12 }}>КОЛЛЕКЦИЯ · СТЕНД</div>
          <h1 style={{ fontSize: 42, margin: "0 0 12px" }}>Ваша музыка рядом</h1>
          <p style={{ color: "#999" }}>Фон приложения остаётся на месте при открытии PulseParty.</p>
          <section
            data-test-id="VIBE_PLAYERBAR"
            style={{ marginTop: 32, padding: 24, borderRadius: 24, background: "#25221a" }}
          >
            <div style={{ fontSize: 24, fontWeight: 650, marginBottom: 80 }}>Моя волна</div>
            <div
              className="PulseSync_waveSideControls_right"
              style={{ position: "relative", display: "flex", gap: 16, alignItems: "center" }}
            >
              <span>♡</span>
              <span>⋯</span>
              <PartyLauncher placement="wave" open={() => setOpen(true)} />
            </div>
          </section>
        </div>
      </main>
      <footer
        style={{
          position: "fixed",
          bottom: 8,
          left: 12,
          right: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "12px 16px",
          borderRadius: 16,
          background: "#2b2b2b",
        }}
      >
        <span style={{ fontSize: 13 }}>
          Тёплый вечер
          <br />
          <small style={{ color: "#aaa" }}>Тестовый плеер</small>
        </span>
        <span style={{ color: "#ffdb4d", fontSize: 28 }}>Ⅱ</span>
        <div style={{ display: "flex", alignItems: "center" }}>
          <PartyLauncher open={() => setOpen(true)} />
          <span>◖</span>
        </div>
      </footer>
      <p id="notice" style={{ position: "fixed", top: 8, right: 12 }} />
      {open && <PartyOverlay controller={party} close={() => setOpen(false)} />}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<PreviewApp />);
window.addEventListener("beforeunload", () => party.dispose());
