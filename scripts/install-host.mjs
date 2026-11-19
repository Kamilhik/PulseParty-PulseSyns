import { createReadStream } from "node:fs";
import {
  access,
  cp,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { Script } from "node:vm";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPackageFromStreams,
  extractFile,
  getRawHeader,
  statFile,
  uncache,
} from "@electron/asar";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "dist/native-install");
const planPath = path.join(destination, "plan.json");
const archive = path.join(
  process.env.LOCALAPPDATA || "",
  "Programs/YandexMusic/resources/app.asar",
);
const digest = async (file) => {
  const hash = createHash("sha256");
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest("hex");
};
const marker = "// for PulseSync: BEGIN embedded PulseParty";
const prefix = "main/lib/pulseparty/";

function assertMusicClosed() {
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "@(Get-Process -Name 'Яндекс Музыка' -ErrorAction SilentlyContinue).Count",
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  if (Number(output) > 0)
    throw Error("Полностью закройте Яндекс Музыку, включая значок в трее, и повторите установку.");
}
function entries(header) {
  const result = [];
  function walk(node, base = "", inherited = false) {
    for (const [name, value] of Object.entries(node.files || {})) {
      const relative = base + name;
      if (name === ".." || /[\\/]/.test(name)) throw Error("Unsafe ASAR entry");
      const unpacked = !!(inherited || value.unpacked);
      if (value.files) {
        result.push({ path: relative, type: "directory", value, unpacked });
        walk(value, relative + "/", unpacked);
      } else if (value.link)
        throw Error("This installer does not support archives containing symlinks");
      else result.push({ path: relative, type: "file", value, unpacked });
    }
  }
  walk(header);
  return result;
}
function patchMain(text) {
  if (text.includes(marker)) return text;
  const anchor = /\(0,\s*singleInstance_js_1\.checkForSingleInstance\)\(\)/g;
  if (
    [...text.matchAll(anchor)].length !== 1 ||
    !text.includes("store_js_1") ||
    !text.includes("electron_1")
  )
    throw Error("Неизвестная точка запуска хоста. Автоматическая установка остановлена.");
  const expression =
    'require("./lib/pulseparty/index.cjs").start({app:electron_1.app,BrowserWindow:electron_1.BrowserWindow,store:store_js_1})';
  const output = text.replace(
    anchor,
    (match) => `(${match},\n${marker}\n${expression}\n// for PulseSync: END embedded PulseParty\n)`,
  );
  new Script(output, { filename: "main/index.js" });
  return output;
}

async function prepare() {
  const header = getRawHeader(archive),
    original = entries(header.header);
  const pkg = JSON.parse(extractFile(archive, "package.json"));
  if (pkg.version !== "5.128.0" || pkg.modification?.version !== "2.2.1")
    throw Error(
      "Установщик подготовлен для Яндекс Музыки 5.128.0 / PulseSync-mod 2.2.1. Для другой версии нужна отдельная проверка.",
    );
  const originalHash = await digest(archive),
    main = Buffer.from(patchMain(extractFile(archive, "main/index.js").toString("utf8")));
  const work = path.join(root, ".research", "native-install-" + Date.now());
  await mkdir(work, { recursive: true });
  const staged = path.join(work, "app.asar");
  const dataOffset = 8 + header.headerSize;
  const streams = original
    .filter((entry) => !entry.path.startsWith(prefix))
    .map((entry) => {
      const common = {
        path: entry.path,
        type: entry.type,
        unpacked: entry.unpacked,
        stat: { size: entry.value.size ?? 0, mode: entry.type === "directory" ? 0o755 : 0o644 },
      };
      if (entry.type === "directory") return common;
      if (entry.path === "main/index.js")
        return {
          ...common,
          stat: { ...common.stat, size: main.length },
          streamGenerator: () => Readable.from([main]),
        };
      return {
        ...common,
        streamGenerator: () =>
          entry.unpacked
            ? createReadStream(path.join(archive + ".unpacked", entry.path))
            : entry.value.size
              ? createReadStream(archive, {
                  start: dataOffset + Number(entry.value.offset),
                  end: dataOffset + Number(entry.value.offset) + entry.value.size - 1,
                })
              : Readable.from([]),
      };
    });
  const host = path.join(root, "dist/host/pulseparty");
  await access(path.join(host, "index.cjs"));
  async function add(directory, relative = "") {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name),
        name = relative + item.name;
      if (item.isDirectory()) {
        streams.push({
          path: prefix + name,
          type: "directory",
          unpacked: false,
          stat: { size: 0, mode: 0o755 },
        });
        await add(file, name + "/");
      } else
        streams.push({
          path: prefix + name,
          type: "file",
          unpacked: item.name.endsWith(".node"),
          stat: await stat(file),
          streamGenerator: () => createReadStream(file),
        });
    }
  }
  await add(host);
  await createPackageFromStreams(staged, streams);
  uncache(staged);
  if (extractFile(staged, "main/index.js").toString() !== main.toString())
    throw Error("Main verification failed");
  let unchanged = 0;
  for (const entry of original) {
    if (entry.type !== "file" || entry.path === "main/index.js" || entry.path.startsWith(prefix))
      continue;
    const next = statFile(staged, path.normalize(entry.path));
    if (next.size !== entry.value.size || !!next.unpacked !== entry.unpacked)
      throw Error("Archive layout mismatch: " + entry.path);
    const expected =
      entry.value.integrity?.hash ??
      createHash("sha256")
        .update(extractFile(archive, path.normalize(entry.path)))
        .digest("hex");
    if (next.integrity?.hash !== expected) throw Error("Unchanged file mismatch: " + entry.path);
    unchanged++;
  }
  const native = streams.filter(
    (s) => s.path.startsWith(prefix) && s.type === "file" && s.unpacked,
  );
  if (native.length !== 1) throw Error("Expected one Windows x64 native binding");
  await mkdir(destination, { recursive: true });
  await writeFile(
    planPath,
    JSON.stringify(
      {
        format: 1,
        archive,
        originalHash,
        staged,
        patchedHash: await digest(staged),
        unchangedFiles: unchanged,
        version: pkg.version,
        modVersion: pkg.modification.version,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      prepared: true,
      unchangedFiles: unchanged,
      archiveChanged: false,
      version: pkg.version,
      modVersion: pkg.modification.version,
    }),
  );
}
async function apply() {
  assertMusicClosed();
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  if (plan.archive !== archive || plan.format !== 1) throw Error("Invalid install plan");
  if ((await digest(archive)) !== plan.originalHash)
    throw Error("Яндекс Музыка обновилась после подготовки. Запустите --prepare заново.");
  if ((await digest(plan.staged)) !== plan.patchedHash) throw Error("Prepared archive changed");
  const backup = path.join(
    process.env.LOCALAPPDATA,
    "PulseParty",
    "backups",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  await mkdir(backup, { recursive: true });
  await copyFile(archive, path.join(backup, "app.asar"));
  if ((await digest(path.join(backup, "app.asar"))) !== plan.originalHash)
    throw Error("Backup verification failed");
  const nativeSource = path.join(plan.staged + ".unpacked", prefix);
  const nativeTarget = path.join(archive + ".unpacked", prefix);
  try {
    await access(nativeTarget);
    await cp(nativeTarget, path.join(backup, "native-previous"), { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await cp(nativeSource, nativeTarget, { recursive: true });
  const temporary = archive + ".pulseparty-next";
  await copyFile(plan.staged, temporary);
  assertMusicClosed();
  await rename(temporary, archive);
  await writeFile(
    path.join(backup, "restore.json"),
    JSON.stringify(
      { archive, originalHash: plan.originalHash, patchedHash: plan.patchedHash },
      null,
      2,
    ),
  );
  console.log(
    "Встроенный модуль установлен. Резервная копия: " +
      backup +
      "\nЗапустите Яндекс Музыку обычным способом.",
  );
}
async function restore(directory){
  assertMusicClosed();const backup=path.resolve(directory);const info=JSON.parse(await readFile(path.join(backup,'restore.json'),'utf8'));
  if(info.archive!==archive)throw Error('Invalid restore target');
  if(await digest(archive)!==info.patchedHash)throw Error('Приложение уже изменилось после установки PulseParty. Автоматический откат остановлен.');
  if(await digest(path.join(backup,'app.asar'))!==info.originalHash)throw Error('Backup verification failed');
  const temporary=archive+'.pulseparty-restore';await copyFile(path.join(backup,'app.asar'),temporary);assertMusicClosed();await rename(temporary,archive);
  console.log('Исходный архив восстановлен. Запустите Яндекс Музыку обычным способом.');
}
try {
  if (process.argv.includes("--prepare")) await prepare();
  else if (process.argv.includes("--apply")) await apply();
  else if(process.argv.includes('--restore'))await restore(process.argv[process.argv.indexOf('--restore')+1]);
  else
    throw Error(
      "Используйте --prepare для подготовки или --apply после полного закрытия Яндекс Музыки.",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
