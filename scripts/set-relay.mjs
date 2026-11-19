import { readFile, writeFile } from "node:fs/promises";
const raw = process.argv[2];
if (!raw) throw new Error("Pass the real deployed HTTPS origin: node scripts/set-relay.mjs <url>");
const url = new URL(raw);
if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
  throw new Error("Expected an HTTPS origin without a path, credentials or parameters");
const deadline = Date.now() + (process.argv.includes("--wait") ? 600_000 : 0);
let attempt = 0;
for (;;) {
  try {
    const response = await fetch(url.origin + "/v1/health", { signal: AbortSignal.timeout(8000) });
    const value = await response.json();
    if (!response.ok || value.ok !== true || value.protocol !== 1)
      throw new Error("The deployed PulseParty service did not pass its health check");
    break;
  } catch (error) {
    if (Date.now() >= deadline) throw error;
    console.log("Waiting for public HTTPS activation; attempt " + (++attempt));
    await new Promise(resolve => setTimeout(resolve, 15_000));
  }
}
const current = await readFile(".env", "utf8").catch(() => "");
const lines = current.split(/\r?\n/).filter(line => !/^\s*PULSEPARTY_(RELAY_URL|TRANSPORT)\s*=/.test(line));
await writeFile(".env", lines.join("\n").trimEnd() + "\nPULSEPARTY_RELAY_URL=" + url.origin + "\n");
console.log("Shared service verified and configured. Run npm run build to rebuild the addon and its network manifest.");
