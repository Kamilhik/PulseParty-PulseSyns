import { Client, type SetActivity } from "@xhayper/discord-rpc";
import { EventEmitter } from "node:events";
import type { Presence, DiscordWorker } from "../companion/native-worker.js";
export class EmbeddedDiscord implements DiscordWorker {
  readonly events = new EventEmitter();
  status = "Discord выключен";
  private client: Client | null = null;
  private desired: Presence | null = null;
  private last = "";
  private lastAt = 0;
  private appId = "";
  private stopping = false;
  private connecting = false;
  private busy = false;
  private joinReady = false;
  private timer = setInterval(() => {
    void this.tick();
  }, 1000);
  constructor(private registerLaunch: (id: string) => void) {
    this.timer.unref();
  }
  configure(appId: string) {
    if (!/^\d{17,20}$/.test(appId)) throw Error("Укажите собственный Discord Application ID");
    void this.client?.destroy().catch(() => {});
    this.client = null;
    this.joinReady = false;
    this.appId = appId;
    this.last = "";
    this.registerLaunch(appId);
  }
  private async tick() {
    if (this.stopping || !this.appId || this.busy) return;
    this.busy = true;
    try {
      if (!this.client && !this.connecting) {
        this.connecting = true;
        const client = new Client({ clientId: this.appId, transport: { type: "ipc" } });
        this.client = client;
        // Early callback; subscribe as soon as the local RPC handshake completes.
        client.on("ACTIVITY_JOIN", (data) => {
          const secret = (data as { secret?: unknown })?.secret;
          if (typeof secret === "string") this.events.emit("join", secret);
        });
        client.on("disconnected", () => {
          if (this.client === client) {
            this.client = null;
            this.joinReady = false;
            this.last = "";
            this.status = "Discord отключён";
          }
        });
        try {
          await client.login();
          await client.subscribe("ACTIVITY_JOIN");
          this.joinReady = true;
          this.status = "Discord подключён · приглашения RPC";
        } catch {
          this.joinReady = false;
          this.status = "Discord RPC недоступен или приглашения не разрешены";
          if (!client.isConnected) {
            await client.destroy().catch(() => {});
            if (this.client === client) this.client = null;
          }
        } finally {
          this.connecting = false;
        }
      }
      const client = this.client;
      if (!client?.isConnected || !client.user) return;
      const signature = JSON.stringify(this.desired);
      if (signature === this.last && Date.now() - this.lastAt < 15000) return;
      if (Date.now() - this.lastAt < 4000) return;
      this.lastAt = Date.now();
      if (!this.desired) {
        await client.user.clearActivity();
        this.last = signature;
        return;
      }
      const p = this.desired;
      const activity: SetActivity = {
        name: "PulseParty · Яндекс Музыка",
        type: p.type === "listening" ? 2 : 0,
        details: p.title.slice(0, 128),
        state: (p.artist + " · " + p.state).slice(0, 128),
        partyId: p.roomId,
        partySize: p.size,
        partyMax: p.maxSize,
        ...(p.cover ? { largeImageKey: p.cover, largeImageText: p.title.slice(0, 128) } : {}),
        ...(p.start ? { startTimestamp: p.start * 1000, endTimestamp: p.end * 1000 } : {}),
        ...(p.joinSecret && this.joinReady ? { joinSecret: p.joinSecret } : {}),
      };
      const response = await client.user.setActivity(activity);
      if (response.type !== activity.type) {
        this.status = "Discord изменил тип активности. Выберите Playing в настройках.";
        return;
      }
      this.last = signature;
      this.status = this.joinReady
        ? p.type === "listening"
          ? "Подключено · Listening / RPC"
          : "Подключено · Playing / RPC"
        : "Статус подключён; нативные приглашения недоступны";
    } catch {
      this.last = "";
      this.status = "Не удалось обновить Discord";
    } finally {
      this.busy = false;
    }
  }
  update(value: Presence) {
    this.desired = value;
  }
  clear() {
    this.desired = null;
    this.last = "";
    void this.client?.user?.clearActivity().catch(() => {});
  }
  stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.clear();
    void this.client?.destroy().catch(() => {});
  }
}
