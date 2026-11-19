import { readFile, writeFile, cp, access } from "node:fs/promises";
import path from "node:path";
// Operates on a caller-selected SOURCE checkout, never on the installed app.asar.
const input = process.argv[2];
if (!input) throw Error("Usage: node scripts/prepare-host.mjs <PulseSync-mod source checkout>");
const target = path.resolve(input);
const main = path.join(target, "src/main/index.js");
const source = await readFile(main, "utf8");
const anchor = "(0, singleInstance_js_1.checkForSingleInstance)();";
if (!source.includes(anchor)) throw Error("Unsupported host source: startup anchor not found");
await access(path.join(target, "AGENTS.md"));
await access("dist/host/pulseparty/index.cjs");
await cp("dist/host/pulseparty", path.join(target, "src/main/lib/pulseparty"), { recursive: true });
const marker = "// for PulseSync: BEGIN embedded PulseParty";
if (!source.includes(marker)) {
  await writeFile(main + ".pulseparty-original", source);
  const injection =
    "\n// for PulseSync: BEGIN embedded PulseParty\nrequire('./lib/pulseparty/index.cjs').start({ app: electron_1.app, BrowserWindow: electron_1.BrowserWindow, store: store_js_1 });\n// for PulseSync: END embedded PulseParty\n";
  await writeFile(main, source.replace(anchor, anchor + injection));
}
console.log(
  "Prepared source checkout: " +
    target +
    "\nBuild using that checkout's documented mod build. Installed app not changed.",
);
