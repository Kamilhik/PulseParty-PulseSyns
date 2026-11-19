import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const out = "dist/host/pulseparty";
await mkdir(out, { recursive: true });
await build({
  entryPoints: ["host/entry.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: out + "/index.cjs",
  external: ["@number0/iroh"],
  minify: false,
});
for (const packageName of ["iroh", "iroh-win32-x64-msvc"]) {
  const dir = "node_modules/@number0/" + packageName;
  await cp(dir, out + "/node_modules/@number0/" + packageName, { recursive: true });
}
await writeFile(
  "dist/host/INTEGRATION.txt",
  "Load pulseparty/index.cjs from PulseSync main process. See README.md and scripts/prepare-host.mjs. No standalone program or hosted room server. Windows x64 native iroh binary included.\n",
);
console.log("dist/host: embedded Windows x64 iroh and Discord RPC integration");
