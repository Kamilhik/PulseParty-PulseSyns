import { readdir, readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { zipSync } from "fflate";
import path from "node:path";
import { createHash } from "node:crypto";
const files = {};
async function collect(directory, prefix) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if(prefix==='companion/native/'&&['sdk','build'].includes(item.name))continue;
    if(item.name==='.env'||item.name.endsWith('.local.json'))continue;
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await collect(file, prefix + item.name + "/");
    else files[prefix + item.name] = new Uint8Array(await readFile(file));
  }
}
await collect("dist/pulseparty", "pulseparty/");
await writeFile("dist/PulseParty-addon.zip", zipSync(files, { level: 9 }));
const metadata = JSON.parse(await readFile("dist/pulseparty/metadata.json", "utf8"));
const flatAddon = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name.slice("pulseparty/".length), bytes]));
const packageBytes = zipSync(flatAddon, { level: 9 });
const releaseAssets = [`PulseParty-${metadata.version}.zip`, `PulseParty-${metadata.version}.pext`];
for (const name of releaseAssets) await writeFile("dist/" + name, packageBytes);
await writeFile("dist/SHA256SUMS.txt", releaseAssets.map(name => createHash("sha256").update(packageBytes).digest("hex") + "  " + name).join("\n") + "\n");
for (const key of Object.keys(files)) delete files[key];
await collect("dist/host", "host/");
await writeFile("dist/PulseParty-host-Windows-x64.zip", zipSync(files, { level: 6 }));
for(const key of Object.keys(files))delete files[key];
for(const directory of ['src','host','server','cloudflare','shared','companion','tests','scripts','docs','preview','web','addon'])await collect(directory,directory+'/');
for(const file of ['README.md','.env.example','.gitignore','.dockerignore','package.json','package-lock.json','tsconfig.json','tsconfig.services.json','addon.config.mjs','vite.config.ts','vite.preview.config.ts','wrangler.jsonc','Dockerfile','compose.yaml','Caddyfile'])files[file]=new Uint8Array(await readFile(file));
await writeFile('dist/PulseParty-source.zip',zipSync(files,{level:9}));
await mkdir("dist/services/web", { recursive: true });
for (const file of await readdir("web")) await copyFile("web/" + file, "dist/services/web/" + file);
console.log("dist/PulseParty-addon.zip");
