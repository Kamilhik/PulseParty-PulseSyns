import { createRelay } from "./http.js";
import { Rooms } from "./rooms.js";
const number = (key: string, fallback: number) => {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid " + key);
  return value;
};
const { server } = createRelay(
  new Rooms({
    maxSize: number("MAX_PARTICIPANTS", 16),
    maxRooms: number("MAX_ROOMS", 1000),
    inviteTtlMs: number("INVITE_TTL_MS", 3600000),
    graceMs: number("HOST_GRACE_MS", 20000),
    roomTtlMs: number("ROOM_TTL_MS", 3600000),
  }),
);
server.listen(number("PORT", 8787), process.env.BIND_HOST || "127.0.0.1", () =>
  console.log("PulseParty relay ready"),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
  });
