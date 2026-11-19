import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "../server/rooms.js";
import { secretSchema } from "./protocol.js";
export async function body(req: IncomingMessage, limit = 16384): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new HttpError(415, "json-required");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "body-too-large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid-json");
  }
}
export function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
export function bearer(req: IncomingMessage) {
  const v = req.headers.authorization;
  if (!v?.startsWith("Bearer ")) throw new HttpError(401, "token-required");
  return secretSchema.parse(v.slice(7));
}
export function allowedOrigin(origin: string | undefined) {
  return (
    !!origin &&
    (/^https:\/\/addon-\d+\.pulsesync\.invalid$/.test(origin) ||
      origin === "music-application://desktop" ||
      origin === "http://127.0.0.1:5173")
  );
}
