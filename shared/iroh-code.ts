import { z } from "zod";
import { secretSchema } from "./protocol.js";
export const peerIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export function encodeCode(peerId: string, invite: string) {
  return "pp1." + peerIdSchema.parse(peerId) + "." + secretSchema.parse(invite);
}
export function decodeCode(code: string) {
  const match = /^pp1\.([a-f0-9]{64})\.([A-Za-z0-9_-]{43})$/.exec(code);
  if (!match) throw new Error("Некорректный код PulseParty");
  return { peerId: peerIdSchema.parse(match[1]), invite: secretSchema.parse(match[2]) };
}
