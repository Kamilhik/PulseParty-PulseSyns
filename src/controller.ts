import type { AddonApi } from "@pulsesync/addon-sdk";
import {
  parseInvite,
  type Action,
  type Envelope,
  type Session,
  type Snapshot,
} from "../shared/protocol.js";
import { RelayClient, ApiError, abortableDelay, opId } from "./transport.js";
import { sdkPlayer } from "./player-adapter.js";
import { Synchronizer } from "./sync.js";
import { musicName } from "./identity.js";

export type View = {
  name: string;
  hostStatus: "checking" | "ready" | "missing" | "unavailable" | "unconfigured";
  snapshot: Snapshot | null;
  memberId: string;
  connection: string;
  sync: string;
  error: string;
  rtt: number;
  drift: number;
  discord: string;
  discordEnabled: boolean;
  pending: { id: string; invite: string } | null;
  invite: string;
  busy: boolean;
};
export const friendlyError = (error: unknown) => {
  const codes: Record<string, string> = {
    "relay-not-configured": "В этой сборке ещё не настроен адрес сервиса комнат.",
    "relay-unavailable": "Сервис комнат недоступен. Проверьте интернет и попробуйте ещё раз.",
    "host-not-installed":
      "Для комнат нужен встроенный модуль PulseParty. Сейчас установлен только интерфейс аддона.",
    "host-unavailable":
      "Встроенный модуль PulseParty не отвечает. Перезапустите Яндекс Музыку и проверьте подключение.",
    "bridge-token-required":
      "Требуется встроенное расширение хоста PulseParty. Перезапустите Яндекс Музыку после установки.",
    "peer-timeout":
      "Устройство создателя комнаты недоступно. Проверьте, что Яндекс Музыка у него открыта.",
    "invite-expired": "Приглашение истекло или отозвано.",
    "room-full": "Комната заполнена.",
    "session-expired": "Сессия завершена. Войдите по новому приглашению.",
    "owner-only": "Это действие доступно владельцу.",
    "host-only": "Это действие доступно ведущему.",
    "host-not-ready": "Ведущий ещё подключается. Попробуйте через секунду.",
    "skip-expired": "Очередь переключений уже обновилась.",
    "transfer-owner-or-close": "Сначала передайте владение или закройте комнату.",
    "stale-host": "Ведущий изменился. Обновляем состояние.",
    "rate-limit": "Слишком много запросов. Подождите.",
    "origin-denied": "Origin клиента не разрешён.",
    "pairing-denied": "Код сопряжения неверен или истёк.",
    "presence-conflict": "Отключите обычный Discord RPC PulseSync перед включением PulseParty.",
  };
  return error instanceof ApiError
    ? (codes[error.code] ?? "Не удалось выполнить запрос: " + error.code)
    : error instanceof Error
      ? error.message
      : "Ошибка подключения";
};
export class PartyController {
  private listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private roomAbort: AbortController | null = null;
  private relay: RelayClient;
  private syncer: Synchronizer | null = null;
  private account: string | undefined;
  private pairedToken = "";
  private bridgeToken = "";
  readonly integrated: boolean;
  private discordEnabled = false;
  private bridgeAbort = new AbortController();
  private disposed = false;
  private state: View = {
    name: "Слушатель",
    hostStatus: "checking",
    snapshot: null,
    memberId: "",
    connection: "Не в комнате",
    sync: "",
    error: "",
    rtt: 0,
    drift: 0,
    discord: "Discord-интеграция не подключена",
    discordEnabled: false,
    pending: null,
    invite: "",
    busy: false,
  };
  constructor(
    private api: AddonApi,
    public relayUrl: string,
    private companionUrl: string,
    private thresholdMs = 800,
    private cooldownMs = 3000,
  ) {
    this.integrated = !!relayUrl && relayUrl === companionUrl;
    this.relay = new RelayClient(
      relayUrl,
      (url, init) => this.fetch(url, init),
      this.lifetime.signal,
    );
  }
  private async fetch(url: string, init?: RequestInit & { timeoutMs?: number }) {
    if (!this.relayUrl) throw new ApiError(503, "relay-not-configured");
    if (this.integrated && !this.bridgeToken)
      this.bridgeToken =
        ((await this.api.modSettings?.get("modSettings.pulseParty.bridgeToken")) as string) || "";
    if (this.integrated && !this.bridgeToken) {
      this.update({ hostStatus: "missing" });
      throw new ApiError(503, "host-not-installed");
    }
    try {
      return await this.api.net.fetch(url, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          ...(this.integrated ? { "X-PulseParty-Bridge": this.bridgeToken } : {}),
        },
      });
    } catch (error) {
      if (this.integrated && !init?.signal?.aborted) {
        this.update({ hostStatus: "unavailable" });
        throw new ApiError(503, "host-unavailable");
      }
      if (!this.integrated && !init?.signal?.aborted) {
        this.update({ hostStatus: "unavailable" });
        throw new ApiError(503, "relay-unavailable");
      }
      throw error;
    }
  }
  async checkHost() {
    if (!this.integrated) {
      if (!this.relayUrl) {
        this.update({ hostStatus: "unconfigured" });
        return;
      }
      this.update({ hostStatus: "checking" });
      try {
        const response = await this.fetch(this.relayUrl + "/v1/health", {
          signal: this.lifetime.signal, timeoutMs: 8000,
        });
        const value = await response.json();
        if (!response.ok || value.ok !== true || value.protocol !== 1)
          throw new ApiError(503, "relay-unavailable");
        this.update({ hostStatus: "ready", error: "" });
      } catch {
        this.update({ hostStatus: "unavailable" });
      }
      return;
    }
    this.update({ hostStatus: "checking" });
    this.bridgeToken =
      ((await this.api.modSettings?.get("modSettings.pulseParty.bridgeToken")) as string) || "";
    if (!this.bridgeToken) {
      this.update({ hostStatus: "missing" });
      return;
    }
    try {
      await this.bridge("status");
      this.update({ hostStatus: "ready", error: "" });
    } catch {
      this.update({ hostStatus: "unavailable" });
    }
  }
  get = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private update(patch: Partial<View>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  async start() {
    this.account = (await this.api.user.getLogin()) ?? undefined;
    this.update({ name: musicName(this.account) });
    const saved = await this.api.storage.get<{ session: Session; account: string; relay?: string }>("session");
    this.pairedToken = this.companionUrl
      ? (await this.api.storage.get<string>("companionToken")) ?? "" : "";
    if (this.integrated)
      this.bridgeToken =
        ((await this.api.modSettings?.get("modSettings.pulseParty.bridgeToken")) as string) || "";
    this.discordEnabled = !!this.companionUrl &&
      ((await this.api.storage.get<boolean>("discordEnabled")) ?? false);
    this.update({ discordEnabled: this.discordEnabled });
    await this.checkHost();
    if (saved && saved.account === this.account && saved.relay === this.relayUrl) {
      this.relay.session = saved.session;
      try {
        const result = await this.relay.call("snapshot");
        this.enter(result);
      } catch {
        this.relay.session = null;
        await this.api.storage.remove("session");
      }
    } else await this.api.storage.remove("session");
    if (this.relay.session) await this.rename().catch(() => {});
    if (this.companionUrl) void this.bridgeLoop();
    void this.accountLoop();
  }
  private accept(result: Envelope) {
    if (this.lifetime.signal.aborted || !this.relay.session) return;
    const s = result.snapshot;
    const previous = this.state.snapshot;
    if (previous && (s.roomId !== previous.roomId || s.revision < previous.revision)) return;
    this.syncer?.accept(s);
    this.update({ snapshot: s, rtt: this.relay.rttMs, drift: this.syncer?.driftMs ?? 0 });
  }
  private enter(result: Envelope, seed = false) {
    if (result.session) this.relay.session = result.session;
    if (!this.relay.session) throw new Error("Сессия отсутствует");
    this.roomAbort?.abort();
    this.syncer?.stop();
    this.roomAbort = new AbortController();
    this.syncer = new Synchronizer(this.relay, sdkPlayer(this.api), {
      thresholdMs: this.thresholdMs,
      cooldownMs: this.cooldownMs,
      seed,
      notice: () => {},
      status: (sync) => this.update({ sync, drift: this.syncer?.driftMs ?? 0 }),
    });
    this.update({ snapshot: null, memberId: this.relay.session.memberId, error: "", invite: "" });
    this.accept(result);
    void this.api.storage.set("session", {
      session: { ...this.relay.session },
      account: this.account ?? "",
      relay: this.relayUrl,
    });
    const signal = this.roomAbort.signal;
    void this.syncer.run(signal);
    void this.poll(signal);
  }
  private async rename() {
    const member = this.state.snapshot?.members.find(m => m.id === this.state.memberId);
    if (member && member.name !== this.state.name)
      await this.action({ type: "rename", name: this.state.name, opId: opId() });
  }
  async create() {
    if (this.state.snapshot) throw new Error("Сначала выйдите из текущей комнаты.");
    this.enter(await this.relay.call("rooms", { name: this.state.name }), true);
  }
  async join(input: string) {
    if (this.state.snapshot)
      throw new Error("Сначала выйдите из текущей комнаты, затем примите приглашение.");
    this.enter(await this.relay.call("join", { invite: parseInvite(input, this.relayUrl), name: this.state.name }));
  }
  async action(action: Action) {
    const result = await this.relay.action(action);
    this.accept(result);
    if (result.invite)
      this.update({
        invite: this.integrated
          ? "pulseparty://join#" + result.invite
          : this.relayUrl + "/invite#" + result.invite,
      });
    if (["leave", "close"].includes(action.type)) await this.detach();
    return result;
  }
  async perform(fn: () => Promise<unknown>) {
    if (this.state.busy) return;
    this.update({ busy: true, error: "" });
    try {
      await fn();
    } catch (error) {
      if (!this.lifetime.signal.aborted) this.update({ error: friendlyError(error) });
    } finally {
      this.update({ busy: false });
    }
  }
  private async poll(signal: AbortSignal) {
    let delay = 500;
    let lastClockSync = 0;
    const pollRelay = new RelayClient(this.relayUrl, (url, init) => this.fetch(url, init), signal);
    pollRelay.session = this.relay.session;
    while (!signal.aborted) {
      try {
        const result = await pollRelay.call("poll?after=" + (this.state.snapshot?.revision ?? 0));
        if (signal.aborted) break;
        this.accept(result);
        this.update({ connection: "На связи", hostStatus: "ready" });
        delay = 500;
        if (Date.now() - lastClockSync > 30_000) {
          this.accept(await this.relay.call("snapshot"));
          lastClockSync = Date.now();
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof ApiError && error.status === 401 && error.code === "session-expired") {
          await this.detach();
          this.update({ error: friendlyError(error) });
          break;
        }
        this.update({ connection: "Переподключаемся…" });
        await abortableDelay(delay, signal).catch(() => {});
        delay = Math.min(delay * 2, 8000);
        if (!signal.aborted) {
          try {
            this.accept(await this.relay.call("snapshot"));
          } catch {
            /* next poll reports authorization */
          }
        }
      }
    }
  }
  async detach() {
    this.roomAbort?.abort();
    this.syncer?.stop();
    this.relay.session = null;
    await this.api.storage.remove("session");
    this.update({ snapshot: null, memberId: "", connection: "Не в комнате", sync: "", invite: "" });
    await this.bridge("clear").catch(() => {});
  }
  private async accountLoop() {
    while (!this.lifetime.signal.aborted) {
      await abortableDelay(10_000, this.lifetime.signal).catch(() => {});
      if (this.lifetime.signal.aborted) break;
      try {
        const login = (await this.api.user.getLogin()) ?? undefined;
        if (login !== this.account) {
          await this.detach();
          this.account = login;
          this.update({ error: "Аккаунт изменился. Войдите в комнату заново." });
        }
        const name = musicName(login);
        if (name !== this.state.name) { this.update({ name }); await this.rename(); }
      } catch {
        /* host temporarily unavailable */
      }
    }
  }
  private async bridge(path: string, data: unknown = {}) {
    if (!this.companionUrl) throw new Error("Стандартный SDK PulseSync не предоставляет Discord IPC.");
    const session = this.relay.session;
    const response = await this.fetch(this.companionUrl + "/v1/" + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.integrated && session
          ? {
              Authorization: "Bearer " + session.token,
              "X-PulseParty-Coordinator": session.coordinator ?? "",
            }
          : this.pairedToken
            ? { Authorization: "Bearer " + this.pairedToken }
            : {}),
      },
      body: JSON.stringify(data),
      signal: this.bridgeAbort.signal,
      timeoutMs: this.integrated ? 15000 : 2500,
    });
    const value = await response.json();
    if (!response.ok) throw new ApiError(response.status, value.code);
    return value;
  }
  async pair(code: string) {
    const value = await this.bridge("pair", { code });
    this.pairedToken = value.token;
    await this.api.storage.set("companionToken", value.token);
    this.update({ discord: "Сопряжено. Включите показ активности." });
  }
  async configureDiscord(
    applicationId: string,
    activityType: "listening" | "playing" = "listening",
  ) {
    await this.bridge("configure", { applicationId, activityType });
    await this.api.storage.set("discordApplicationId", applicationId);
    this.update({ discord: "Discord настроен. Включите показ активности." });
  }
  async setDiscord(enabled: boolean) {
    if (enabled && !this.companionUrl)
      throw new Error("Стандартный SDK PulseSync не предоставляет Discord IPC.");
    if (enabled) {
      const rpcEnabled = await this.api.modSettings?.get("modSettings.discordRPC.enable");
      if (rpcEnabled !== false) throw new ApiError(409, "presence-conflict");
      if (!(this.integrated ? this.bridgeToken : this.pairedToken))
        throw new Error(
          this.integrated
            ? "Требуется встроенное расширение хоста PulseParty."
            : "Сначала запустите companion и выполните сопряжение.",
        );
    } else await this.bridge("clear").catch(() => {});
    this.discordEnabled = enabled;
    await this.api.storage.set("discordEnabled", enabled);
    this.update({
      discordEnabled: enabled,
      discord: enabled ? "Подключаем Discord…" : "Показ активности выключен",
    });
  }
  async dismissPending() {
    const pending = this.state.pending;
    if (pending) await this.bridge("ack", { id: pending.id });
    this.update({ pending: null });
  }
  private async bridgeLoop() {
    let profileInvite: { token: string; expiry: number; roomId: string } | null = null;
    while (!this.lifetime.signal.aborted) {
      if ((this.integrated && this.state.hostStatus === "ready") || this.pairedToken) {
        try {
          const status = await this.bridge("status");
          if (status.pending) this.update({ pending: status.pending });
          else this.update({ pending: null });
          this.update({
            discord: this.discordEnabled ? status.discord : "Показ активности выключен",
          });
          const s = this.state.snapshot;
          if (this.discordEnabled && s) {
            const rpcEnabled = await this.api.modSettings?.get("modSettings.discordRPC.enable");
            if (rpcEnabled !== false) {
              await this.setDiscord(false);
              this.update({ error: friendlyError(new ApiError(409, "presence-conflict")) });
            } else {
              if (
                s.ownerId === this.state.memberId &&
                s.profileJoin &&
                s.members.length < s.maxSize
              ) {
                if (
                  !profileInvite ||
                  profileInvite.roomId !== s.roomId ||
                  profileInvite.expiry < this.relay.now() + 30_000
                ) {
                  const result = await this.action({ type: "invite", opId: opId(), profile: true });
                  profileInvite = result.invite
                    ? { token: result.invite, expiry: result.expiresAt!, roomId: s.roomId }
                    : null;
                }
              } else profileInvite = null;
              await this.bridge("presence", {
                snapshot: s,
                memberId: this.state.memberId,
                joinSecret: profileInvite?.token ?? null,
              });
            }
          } else {
            profileInvite = null;
            await this.bridge("clear");
          }
        } catch (error) {
          profileInvite = null;
          await this.bridge("clear").catch(() => {});
          this.update({
            discord:
              error instanceof ApiError && error.status === 401
                ? "Сопряжение истекло. Подключите заново."
                : "Discord-интеграция не подключена",
          });
        }
      }
      await abortableDelay(5000, this.lifetime.signal).catch(() => {});
    }
  }
  dispose() {
    this.roomAbort?.abort();
    this.syncer?.stop();
    this.lifetime.abort();
    void this.bridge("clear")
      .catch(() => {})
      .finally(() => this.bridgeAbort.abort());
    this.disposed = true;
    this.listeners.clear();
  }
}
