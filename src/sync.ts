import { positionAt, type Snapshot, type Playback } from "../shared/protocol.js";
import type { PlayerAdapter } from "./player-adapter.js";
import { RelayClient, ApiError, abortableDelay, opId } from "./transport.js";

export class Synchronizer {
  private current: Snapshot | null = null;
  private generation = 0;
  private lastSeek = -Infinity;
  private lastPublished: (Playback & { at: number }) | null = null;
  private lastEpoch = -1;
  private adopted = false;
  private retryAt = 0;
  private lastError = "";
  private seeded: boolean;
  private pendingWake = false;
  private waiter: (() => void) | null = null;
  private handledSkip = 0;
  driftMs = 0;
  constructor(
    private relay: RelayClient,
    private player: PlayerAdapter,
    private options: {
      thresholdMs: number;
      cooldownMs: number;
      loadTimeoutMs?: number;
      seed?: boolean;
      notice: (text: string) => void;
      status: (text: string) => void;
    },
  ) {
    this.seeded = !!options.seed;
  }
  accept(s: Snapshot) {
    if (this.current && (s.roomId !== this.current.roomId || s.revision < this.current.revision))
      return;
    if (
      !this.current ||
      s.epoch !== this.current.epoch ||
      s.playback.track?.trackId !== this.current.playback.track?.trackId
    ) {
      this.generation++;
      this.retryAt = 0;
    }
    this.current = s;
    this.wake();
  }
  wake = () => {
    this.pendingWake = true;
    this.waiter?.();
  };
  stop() {
    this.generation++;
    this.current = null;
    this.wake();
  }
  async run(signal: AbortSignal) {
    const unsubscribe = this.player.subscribe?.(this.wake);
    try {
    while (!signal.aborted) {
      this.pendingWake = false;
      try {
        await this.step(signal);
      } catch (error) {
        if (signal.aborted) break;
        this.options.status(error instanceof Error ? error.message : "Ошибка плеера");
        if (error instanceof ApiError && error.status === 409) {
          try {
            this.accept((await this.relay.call("snapshot")).snapshot);
            this.lastPublished = null;
          } catch {
            /* poll loop handles reconnect */
          }
        }
      }
      if (!this.pendingWake && !signal.aborted) await this.wait(signal);
    }
    } finally { unsubscribe?.(); }
  }
  private wait(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        if (this.waiter === done) this.waiter = null;
        resolve();
      };
      const timer = setTimeout(done, 200);
      this.waiter = done;
      signal.addEventListener("abort", done, { once: true });
      if (this.pendingWake || signal.aborted) done();
    });
  }
  async step(signal: AbortSignal) {
    let s = this.current;
    if (!s || !this.relay.session || s.closed) return;
    const mine = this.relay.session.memberId;
    const host = s.hostId === mine;
    if (s.epoch !== this.lastEpoch) {
      this.lastEpoch = s.epoch;
      this.adopted = false;
      this.lastPublished = null;
      this.lastSeek = -Infinity;
      this.handledSkip = 0;
    }
    if (host && !s.hostReady) this.adopted = false;
    const generation = this.generation;
    const valid = () => {
      signal.throwIfAborted();
      if (generation !== this.generation)
        throw new DOMException("Состояние изменилось", "AbortError");
    };
    if ((!host || !this.adopted) && !(host && this.seeded && s.epoch === 1 && s.sequence === 0)) {
      if (Date.now() < this.retryAt) return;
      try {
        let local = await this.player.read();
        valid();
        const target = s.playback.track;
        const changed = !!target && local.track?.trackId !== target.trackId;
        if (changed && target) {
          this.options.status("Загружаем трек…");
          await this.player.load(target);
          valid();
          const deadline = Date.now() + (this.options.loadTimeoutMs ?? 12_000);
          do {
            valid();
            local = await this.player.read();
            valid();
            if (local.track?.trackId === target.trackId && local.ready) break;
            await abortableDelay(50, signal);
          } while (Date.now() < deadline);
          if (local.track?.trackId !== target.trackId || !local.ready)
            throw new Error("Трек недоступен или не загрузился. Ждём следующую песню.");
        }
        if (target && !local.ready) {
          this.options.status("Буферизация…");
          return;
        }
        // Playback may change during loading without changing track/epoch. Apply its newest anchor.
        s = this.current!;
        this.driftMs = local.positionMs - positionAt(s.playback, this.relay.now());
        if (
          target &&
          (changed || !this.adopted || Math.abs(this.driftMs) > this.options.thresholdMs) &&
          (changed || !this.adopted || Date.now() - this.lastSeek > this.options.cooldownMs)
        ) {
          valid();
          await this.player.seek(positionAt(s.playback, this.relay.now()));
          valid();
          this.lastSeek = Date.now();
        }
        if (local.playing !== (target ? s.playback.playing : false)) {
          valid();
          await this.player.playing(target ? s.playback.playing : false);
          valid();
        }
      } catch (error) {
        if (signal.aborted || generation !== this.generation) return;
        this.retryAt = Date.now() + 5000;
        const message = error instanceof Error ? error.message : "Ошибка трека";
        this.options.status(message);
        if (message !== this.lastError) {
          this.lastError = message;
          const response = await this.relay.action({
            type: "ready",
            opId: opId(),
            epoch: s.epoch,
            error: "track-unavailable",
          });
          valid();
          this.accept(response.snapshot);
        }
        return;
      }
    }
    valid();
    if (!this.adopted || this.lastError) {
      this.lastError = "";
      const response = await this.relay.action({
        type: "ready",
        opId: opId(),
        epoch: s.epoch,
        error: null,
      });
      valid();
      this.accept(response.snapshot);
      this.adopted = true;
      this.seeded = false;
    }
    if (host) {
      const command = this.current?.skipQueue?.[0];
      if (command && command.epoch === s.epoch && command.expiresAt > this.relay.now()) {
        if (command.id > this.handledSkip) {
          // Remember before the native call. A retry after a failed ACK must
          // never advance the host's queue a second time.
          this.handledSkip = command.id;
          if (this.player.skip) {
            const before = await this.player.read();
            valid();
            await this.player.skip(command.direction);
            valid();
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline) {
              const next = await this.player.read();
              valid();
              if (next.ready && (next.track?.trackId !== before.track?.trackId ||
                (command.direction === "previous" && next.positionMs < before.positionMs - 500))) break;
              await abortableDelay(50, signal);
            }
          }
        }
        valid();
        const acknowledged = await this.relay.action({ type: "skipDone", id: command.id, epoch: s.epoch, opId: opId() });
        valid();
        this.accept(acknowledged.snapshot);
        this.lastPublished = null;
      }
      const local = await this.player.read();
      valid();
      if (local.track && !local.ready) return;
      const playback: Playback = {
        track: local.track,
        playing: local.track ? local.playing : false,
        positionMs: local.track ? Math.min(local.positionMs, local.track.durationMs) : 0,
        rate: 1,
      };
      const previous = this.lastPublished;
      const now = this.relay.now();
      const changed =
        !previous ||
        previous.track?.trackId !== playback.track?.trackId ||
        previous.playing !== playback.playing ||
        Math.abs(
          playback.positionMs - (previous.positionMs + (previous.playing ? now - previous.at : 0)),
        ) > 350;
      if (changed || !previous || now - previous.at >= 5000) {
        const latest = this.current!;
        const result = await this.relay.action({
          type: "publish",
          opId: opId(),
          epoch: latest.epoch,
          sequence: latest.sequence + 1,
          playback,
          sampledAt: now,
        });
        valid();
        this.accept(result.snapshot);
        this.lastPublished = { ...playback, at: now };
      }
    }
    this.options.status(host ? "Вы управляете музыкой" : "Синхронизировано");
  }
}
