import { z } from "zod";

export const VERSION = 1;
export const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,96}$/);
export const secretSchema = z.string().regex(/^[a-zA-Z0-9_-]{43}$/);
export const trackSchema = z
  .object({
    trackId: z.string().regex(/^\d{1,20}(?::\d{1,20})?$/),
    albumId: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional(),
    title: z.string().max(200),
    artist: z.string().max(200),
    cover: z
      .string()
      .max(500)
      .refine((v) => !v || /^https:\/\/avatars\.(mds\.yandex\.net|yandex\.net)\//.test(v))
      .default(""),
    durationMs: z.number().finite().min(0).max(86_400_000),
  })
  .strict();
export const playbackSchema = z
  .object({
    track: trackSchema.nullable(),
    playing: z.boolean(),
    positionMs: z.number().finite().min(0).max(86_400_000),
    rate: z.literal(1),
  })
  .strict();
export type Track = z.infer<typeof trackSchema>;
export type Playback = z.infer<typeof playbackSchema>;
export type AnchoredPlayback = Playback & { at: number };
export type Member = {
  id: string;
  name: string;
  connected: boolean;
  ready: boolean;
  error: string | null;
  joinedAt: number;
};
export type Snapshot = {
  version: 1;
  roomId: string;
  revision: number;
  epoch: number;
  sequence: number;
  ownerId: string;
  hostId: string;
  hostReady: boolean;
  maxSize: number;
  profileJoin: boolean;
  skipMode?: "owner" | "everyone";
  skipQueue?: { id: number; direction: "next" | "previous"; epoch: number; expiresAt: number }[];
  closed: boolean;
  playback: AnchoredPlayback;
  members: Member[];
  requests: string[];
  serverTime: number;
};
export type Session = { roomId: string; memberId: string; token: string; coordinator?: string };
export type Envelope = {
  snapshot: Snapshot;
  session?: Session;
  invite?: string;
  expiresAt?: number;
};
const base = { opId: identifier };
export const actionSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("publish"),
      epoch: z.number().int().nonnegative(),
      sequence: z.number().int().positive(),
      playback: playbackSchema,
      sampledAt: z.number().finite(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("ready"),
      epoch: z.number().int(),
      error: z.string().max(160).nullable(),
    })
    .strict(),
  z.object({ ...base, type: z.literal("handoff"), targetId: identifier }).strict(),
  z.object({ ...base, type: z.literal("request") }).strict(),
  z
    .object({ ...base, type: z.literal("decide"), targetId: identifier, accept: z.boolean() })
    .strict(),
  z.object({ ...base, type: z.literal("transferOwner"), targetId: identifier }).strict(),
  z
    .object({ ...base, type: z.literal("kick"), targetId: identifier, revokeInvites: z.boolean() })
    .strict(),
  z.object({ ...base, type: z.literal("invite"), profile: z.boolean().default(false) }).strict(),
  z.object({ ...base, type: z.literal("revokeInvites") }).strict(),
  z.object({ ...base, type: z.literal("profileJoin"), enabled: z.boolean() }).strict(),
  z.object({ ...base, type: z.literal("skipMode"), mode: z.enum(["owner", "everyone"]) }).strict(),
  z.object({ ...base, type: z.literal("skip"), direction: z.enum(["next", "previous"]) }).strict(),
  z.object({ ...base, type: z.literal("skipDone"), id: z.number().int().positive(), epoch: z.number().int().nonnegative() }).strict(),
  z.object({ ...base, type: z.literal("rename"), name: z.string().trim().min(1).max(48) }).strict(),
  z.object({ ...base, type: z.literal("leave") }).strict(),
  z.object({ ...base, type: z.literal("close") }).strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export function positionAt(p: AnchoredPlayback, serverNow: number): number {
  return Math.max(
    0,
    Math.min(
      p.track?.durationMs || 86_400_000,
      p.positionMs + (p.playing ? Math.max(0, serverNow - p.at) : 0),
    ),
  );
}
// A join code contains only a token. The configured relay is never taken from an invite.
export function parseInvite(input: string, relay: string): string {
  if (/^pp1\.[a-f0-9]{64}\.[A-Za-z0-9_-]{43}$/.test(input.trim())) return input.trim();
  if (secretSchema.safeParse(input.trim()).success) return input.trim();
  const url = new URL(input);
  if (
    url.protocol === "pulseparty:" &&
    url.hostname === "join" &&
    !url.search &&
    !url.pathname &&
    !url.username &&
    !url.password &&
    !url.port
  ) {
    const code = url.hash.slice(1);
    return /^pp1\.[a-f0-9]{64}\.[A-Za-z0-9_-]{43}$/.test(code) ? code : secretSchema.parse(code);
  }
  if (url.origin !== new URL(relay).origin || url.pathname !== "/invite" || url.search)
    throw new Error("Приглашение относится к другому relay");
  return secretSchema.parse(url.hash.slice(1));
}
