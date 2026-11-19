import { randomBytes } from "node:crypto";
import { IrohNetwork } from "./iroh-network.js";
import { EmbeddedDiscord } from "./discord-rpc.js";
import { createEmbeddedGateway } from "./gateway.js";
type HostOptions = {
  app: {
    whenReady(): Promise<void>;
    hasSingleInstanceLock(): boolean;
    setAsDefaultProtocolClient(scheme: string): boolean;
    on(name: string, listener: (...args: any[]) => void): void;
  };
  BrowserWindow: { getAllWindows(): { show(): void; focus(): void; isMainWindow?: boolean }[] };
  store: { get(key: string): unknown; set(key: string, value: unknown): unknown };
};
export function start({ app, BrowserWindow, store }: HostOptions) {
  if (!app.hasSingleInstanceLock()) return;
  const links: unknown[] = [];
  let handle: (url: unknown) => void = (url) => {
    if (links.length < 8) links.push(url);
  };
  const emitter = app as HostOptions["app"] & { prependListener: HostOptions["app"]["on"] };
  emitter.prependListener("open-url", (event, url) => {
    if (typeof url === "string" && url.startsWith("pulseparty://")) {
      event.preventDefault();
      handle(url);
    }
  });
  emitter.prependListener("second-instance", (_event, argv) => {
    if (Array.isArray(argv)) argv.forEach((url) => handle(url));
  });
  process.argv.forEach((url) => handle(url));
  void app
    .whenReady()
    .then(async () => {
      const token = randomBytes(32).toString("base64url");
      const network = await IrohNetwork.start();
      const worker = new EmbeddedDiscord((id) => {
        app.setAsDefaultProtocolClient("discord-" + id);
        store.set("modSettings.pulseParty.applicationId", id);
      });
      const saved = store.get("modSettings.pulseParty.applicationId");
      if (typeof saved === "string" && /^\d{17,20}$/.test(saved)) worker.configure(saved);
      const gateway = createEmbeddedGateway({
        network,
        bridgeToken: token,
        worker,
        configure: (id, type) => {
          worker.configure(id);
          store.set("modSettings.pulseParty.activityType", type);
        },
        activityType: () =>
          store.get("modSettings.pulseParty.activityType") === "playing" ? "playing" : "listening",
        rpcDisabled: () => store.get("modSettings.discordRPC.enable") === false,
        onInvite: () => {
          const w = BrowserWindow.getAllWindows().find((w) => w.isMainWindow);
          w?.show();
          w?.focus();
        },
      });
      app.setAsDefaultProtocolClient("pulseparty");
      handle = (url: unknown) => {
        if (
          typeof url !== "string" ||
          !/^pulseparty:\/\/join#pp1\.[a-f0-9]{64}\.[A-Za-z0-9_-]{43}$/.test(url)
        )
          return;
        void gateway.receive(url.slice("pulseparty://join#".length)).catch(() => {});
      };
      links.splice(0).forEach((url) => handle(url));
      gateway.server.on("error", () => {
        store.set("modSettings.pulseParty.bridgeToken", "");
        void network.stop();
      });
      gateway.server.listen(18787, "127.0.0.1", () =>
        store.set("modSettings.pulseParty.bridgeToken", token),
      );
      app.on("before-quit", () => {
        store.set("modSettings.pulseParty.bridgeToken", "");
        gateway.server.close();
        gateway.server.closeAllConnections();
        void network.stop();
      });
    })
    .catch(() => store.set("modSettings.pulseParty.bridgeToken", ""));
}
