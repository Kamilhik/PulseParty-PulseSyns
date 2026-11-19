import { loadEnv } from "vite";
const env = { ...loadEnv("production", process.cwd(), ""), ...process.env };
const embedded = env.PULSEPARTY_TRANSPORT === "embedded";
const relay = env.PULSEPARTY_RELAY_URL?.trim()
  ? new URL(env.PULSEPARTY_RELAY_URL.trim())
  : embedded ? new URL("http://127.0.0.1:18787") : null;
if (relay && (relay.pathname !== "/" || relay.search || relay.hash || relay.username || relay.password))
  throw new Error("Relay must be an origin");
if (relay && relay.protocol !== "https:" && !(relay.protocol === "http:" && ["127.0.0.1", "localhost"].includes(relay.hostname)))
  throw new Error("Public relay requires HTTPS");
export const relayUrl = relay?.origin ?? "";
export const companionUrl = embedded ? "http://127.0.0.1:18787" : "";
export default {
  id: "pulseparty",
  directoryName: "pulseparty",
  name: "PulseParty",
  description: "Слушайте Яндекс Музыку вместе и передавайте пульт друзьям.",
  version: "0.3.0",
  author: "Kamilhik",
  image: "",
  banner: "",
  libraryLogo: "",
  tags: ["music", "social"],
  dependencies: [],
  supportedVersions: [],
  allowedUrls: [...new Set([
    ...(relay ? [relay.origin + "/v1"] : []),
    ...(companionUrl ? [companionUrl + "/v1"] : []),
  ])],
  requirements: {
    minHostApi: 1,
    capabilities: ["lifecycle-v1", "async-start-v1", "net-per-addon-v1", "scoped-css-v1"],
  },
};
