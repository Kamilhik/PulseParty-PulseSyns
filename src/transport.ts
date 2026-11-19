import type { Action, Envelope, Session } from "../shared/protocol.js";
export type Fetcher = (
  input: string,
  init?: RequestInit & { timeoutMs?: number },
) => Promise<Response>;
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export class RelayClient {
  session: Session | null = null;
  offsetMs = 0;
  rttMs = 0;
  private bestRtt = Infinity;
  constructor(
    public relay: string,
    private fetcher: Fetcher,
    public signal: AbortSignal,
  ) {}
  async call(path: string, data?: unknown): Promise<Envelope> {
    const start = Date.now();
    const response = await this.fetcher(this.relay + "/v1/" + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        ...(this.session
          ? {
              Authorization: "Bearer " + this.session.token,
              ...(this.session.coordinator
                ? { "X-PulseParty-Coordinator": this.session.coordinator }
                : {}),
            }
          : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: this.signal,
      timeoutMs: 15_000,
    });
    const result = await response.json();
    this.signal.throwIfAborted();
    if (!response.ok)
      throw new ApiError(
        response.status,
        typeof result.code === "string" ? result.code : "request-failed",
      );
    if (result.snapshot && result.snapshot.version !== 1)
      throw new Error("Несовместимая версия relay");
    const end = Date.now();
    // Long-poll duration is not network RTT. Only immediate responses calibrate the clock.
    if (result.snapshot && !path.startsWith("poll")) {
      this.rttMs = end - start;
      const offset = result.snapshot.serverTime - (start + end) / 2;
      if (Math.abs(offset - this.offsetMs) > 10_000) this.bestRtt = Infinity;
      if (this.rttMs <= this.bestRtt * 1.25) {
        this.bestRtt = Math.min(this.bestRtt, this.rttMs);
        this.offsetMs = offset;
      }
    }
    return result;
  }
  action(action: Action) {
    return this.call("action", action);
  }
  now() {
    return Date.now() + this.offsetMs;
  }
}
export function opId() {
  return crypto.randomUUID();
}
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
