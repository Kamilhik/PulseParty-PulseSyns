import fs from "node:fs";
import path from "node:path";
const archive = path.join(
  process.env.LOCALAPPDATA || "",
  "Programs/YandexMusic/resources/app.asar",
);
if (!fs.existsSync(archive)) {
  console.log("Installed Yandex Music archive not found.");
  process.exit(0);
}
const fd = fs.openSync(archive, "r");
const header = Buffer.alloc(16);
fs.readSync(fd, header, 0, 16, 0);
const headerData = Buffer.alloc(header.readUInt32LE(12));
fs.readSync(fd, headerData, 0, headerData.length, 16);
const tree = JSON.parse(headerData);
const dataOffset = 8 + header.readUInt32LE(4);
const read = (entry) => {
  if (entry.unpacked) return "";
  const data = Buffer.alloc(entry.size);
  fs.readSync(fd, data, 0, data.length, dataOffset + Number(entry.offset));
  return data.toString("utf8");
};
const pkg = JSON.parse(read(tree.files["package.json"]));
const files = [];
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const file = prefix + name;
    if (entry.files) walk(entry, file + "/");
    else if (file.endsWith(".js") && /pulsesync|webhost|runtime|isolated/i.test(file))
      files.push({ file, entry });
  }
}
walk(tree, "");
const capabilities = new Set();
for (const { file, entry } of files) {
  const text = read(entry);
  for (const key of [
    "lifecycle-v1",
    "async-start-v1",
    "net-per-addon-v1",
    "scoped-css-v1",
    "typed-settings-v1",
    "SetActivityJoinCallback",
    "getPlayerSnapshot",
    "playTrackById",
    "getModSettingSnapshot",
  ])
    if (text.includes(key)) capabilities.add(key);
}
console.log(
  JSON.stringify(
    {
      yandexMusicVersion: pkg.version,
      modVersion: pkg.modification?.version,
      searchedSourceFiles: files.length,
      capabilities: [...capabilities],
      origin: pkg.appConfig?.appProtocol + "://" + pkg.appConfig?.appHostname,
    },
    null,
    2,
  ),
);
fs.closeSync(fd);
