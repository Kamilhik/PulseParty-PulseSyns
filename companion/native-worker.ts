import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
export type Presence = { type: 'listening' | 'playing'; title: string; artist: string; cover: string; state: string; roomId: string; size: number; maxSize: number; start: number; end: number; joinSecret: string; url: string };
export interface DiscordWorker { events: EventEmitter; status: string; update(value: Presence): void; clear(): void; stop(): void }
export class NativeWorker implements DiscordWorker {
  readonly events = new EventEmitter();
  status = 'Social SDK не собран'; private child: ChildProcessWithoutNullStreams | null = null;
  private desired: Presence | null = null; private lastSent = ''; private lastUpdate = 0; private retryAt = 0; private stopped = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private executable: string, private applicationId: string, private launchCommand: string) { this.timer = setInterval(() => this.tick(), 500); this.timer.unref(); this.tick(); }
  private tick() {
    if (this.stopped) return;
    if (!this.child && Date.now() >= this.retryAt) {
      this.retryAt = Date.now() + 5000;
      if (!existsSync(this.executable) || !/^\d{17,20}$/.test(this.applicationId)) { this.status = !existsSync(this.executable) ? 'Social SDK не собран' : 'Не настроен Discord Application ID'; return; }
      const child = spawn(this.executable, [this.applicationId, this.launchCommand], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); this.child = child; this.lastSent = '';
      this.status = 'Подключаем Discord…';
      createInterface({ input: child.stdout }).on('line', line => {
        if (line.length > 512) return;
        const [kind, value] = line.split('\t');
        if (kind === 'JOIN' && /^[\w-]{43}$/.test(value)) this.events.emit('join', value);
        if (kind === 'STATUS') { this.status = ({ listening: 'Подключено · Listening', playing: 'Подключено · Playing (fallback)', error: 'Discord недоступен или режим не поддерживается', ready: 'Social SDK готов' } as Record<string,string>)[value] ?? 'Ошибка Social SDK'; if (value === 'error') this.lastSent = ''; }
      });
      // Do not forward SDK logs: they can contain private activity details.
      child.stderr.resume(); child.on('error', () => { this.status = 'Не удалось запустить Social SDK'; });
      child.on('exit', () => { if (this.child === child) this.child = null; this.status = 'Discord отключён'; });
      child.stdin.on('error', () => {});
    }
    const serialized = JSON.stringify(this.desired);
    if (this.child && (serialized !== this.lastSent || (this.desired && Date.now() - this.lastUpdate >= 15_000)) && Date.now() - this.lastUpdate >= 4000) {
      this.lastUpdate = Date.now(); this.lastSent = serialized;
      if (!this.desired) this.child.stdin.write('CLEAR\n');
      else { const p = this.desired; const encode = (s: string) => s ? Buffer.from(s).toString('base64') : '-'; this.child.stdin.write(['PRESENCE', p.type, encode(p.title), encode(p.artist), encode(p.cover), encode(p.state), encode(p.roomId), p.size, p.maxSize, p.start, p.end, encode(p.joinSecret), encode(p.url)].join(' ') + '\n'); }
    }
  }
  update(value: Presence) { this.desired = value; }
  clear() { this.desired = null; this.lastSent = ''; this.child?.stdin.write('CLEAR\n'); }
  stop() { this.stopped = true; clearInterval(this.timer); this.child?.stdin.end('STOP\n'); const child = this.child; setTimeout(() => child?.kill(), 1000).unref(); }
}
