import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCompanion, type Pairing } from './http.js';
import { NativeWorker } from './native-worker.js';
import { parseInvite } from '../shared/protocol.js';
const relay = new URL(process.env.PULSEPARTY_RELAY_URL || 'http://127.0.0.1:8787');
if (relay.pathname !== '/' || relay.search || relay.hash || relay.username || relay.password || (relay.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(relay.hostname))) throw new Error('Invalid configured relay');
const directory = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'PulseParty');
await mkdir(directory, { recursive: true, mode: 0o700 });
const localState = path.join(directory, 'companion.local.json');
let state: { launchSecret: string; pairing: Pairing };
try { state = JSON.parse(await readFile(localState, 'utf8')); } catch { state = { launchSecret: randomBytes(32).toString('base64url'), pairing: null }; }
const persist = () => writeFile(localState, JSON.stringify(state), { mode: 0o600 }); await persist();
const input = process.argv.includes('--join') ? process.argv[process.argv.indexOf('--join') + 1] : undefined;
const invite = input && input !== 'pulseparty://launch' ? parseInvite(input, relay.origin) : null;
try {
  const response = await fetch('http://127.0.0.1:18787/v1/launch', { method: 'POST', headers: { Authorization: 'Bearer ' + state.launchSecret, 'Content-Type': 'application/json' }, body: JSON.stringify({ invite: invite ?? 'invalid' }), signal: AbortSignal.timeout(500) });
  if (response.ok || response.status === 400) process.exit(0);
} catch { /* start the single loopback server */ }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const nativePath = path.resolve(process.env.DISCORD_WORKER_PATH || path.join(root, 'companion/native/build/Release/pulseparty-discord.exe'));
const worker = new NativeWorker(nativePath, process.env.DISCORD_APPLICATION_ID || '', 'pulseparty://launch');
const bridge = createCompanion({ relay: relay.origin, worker, launchSecret: state.launchSecret, pairing: state.pairing, savePairing: async pairing => { state.pairing = pairing; await persist(); }, activityType: process.env.DISCORD_ACTIVITY_TYPE === 'playing' ? 'playing' : 'listening', onInvite: () => {
  console.log('Приглашение получено. Откройте панель PulseParty в Яндекс Музыке.');
  if (process.platform === 'win32') { const child = spawn('explorer.exe', ['yandexmusic://'], { windowsHide: true, stdio: 'ignore' }); child.on('error', () => {}); child.unref(); }
} });
bridge.server.on('error', () => { worker.stop(); console.error('Не удалось запустить companion: порт занят.'); process.exitCode = 1; });
bridge.server.listen(18787, '127.0.0.1', () => { console.log('PulseParty companion. Код сопряжения (5 минут): ' + bridge.code); if (invite) void bridge.receive(invite).catch(() => console.error('Приглашение недействительно.')); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { bridge.server.close(); bridge.server.closeAllConnections(); });
