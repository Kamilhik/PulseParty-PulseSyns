import { randomBytes, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  positionAt,
  type Action,
  type AnchoredPlayback,
  type Envelope,
  type Member,
  type Session,
  type Snapshot,
} from "../shared/protocol.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
const token = () => randomBytes(32).toString("base64url");
const id = () => randomBytes(12).toString("base64url");
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
type Participant = Member & {
  tokenHash: string;
  lastSeen: number;
  ops: Map<string, { fingerprint: string; result: Envelope }>;
};
type Room = {
  id: string;
  ownerId: string;
  hostId: string;
  epoch: number;
  sequence: number;
  revision: number;
  hostReady: boolean;
  profileJoin: boolean;
  skipMode: "owner" | "everyone";
  skipQueue: NonNullable<Snapshot["skipQueue"]>;
  skipSequence: number;
  lastSkipAt: number;
  closed: boolean;
  createdAt: number;
  updatedAt: number;
  members: Map<string, Participant>;
  requests: Set<string>;
  playback: AnchoredPlayback;
  invites: Map<string, { expiresAt: number; profile: boolean }>;
};
export type RoomConfig = {
  maxSize: number;
  maxRooms: number;
  maxInvites: number;
  inviteTtlMs: number;
  graceMs: number;
  roomTtlMs: number;
  now: () => number;
};
export class Rooms {
  readonly events = new EventEmitter();
  readonly rooms = new Map<string, Room>();
  readonly sessions = new Map<string, { room: Room; member: Participant }>();
  readonly invites = new Map<string, Room>();
  readonly config: RoomConfig;
  constructor(config: Partial<RoomConfig> = {}) {
    this.config = {
      maxSize: 16,
      maxRooms: 1000,
      maxInvites: 32,
      inviteTtlMs: 3_600_000,
      graceMs: 20_000,
      roomTtlMs: 3_600_000,
      now: Date.now,
      ...config,
    };
    this.events.setMaxListeners(0);
  }
  private add(room: Room, name: string): Session {
    const raw = token();
    const now = this.config.now();
    const member: Participant = {
      id: id(),
      name,
      connected: true,
      ready: false,
      error: null,
      joinedAt: now,
      tokenHash: hash(raw),
      lastSeen: now,
      ops: new Map(),
    };
    room.members.set(member.id, member);
    this.sessions.set(member.tokenHash, { room, member });
    return { roomId: room.id, memberId: member.id, token: raw };
  }
  create(name: string): Envelope {
    if (this.rooms.size >= this.config.maxRooms) throw new HttpError(503, "room-limit");
    const now = this.config.now();
    const room: Room = {
      id: id(),
      ownerId: "",
      hostId: "",
      epoch: 1,
      sequence: 0,
      revision: 1,
      hostReady: false,
      profileJoin: false,
      skipMode: "owner",
      skipQueue: [],
      skipSequence: 0,
      lastSkipAt: -Infinity,
      closed: false,
      createdAt: now,
      updatedAt: now,
      members: new Map(),
      requests: new Set(),
      invites: new Map(),
      playback: { track: null, playing: false, positionMs: 0, rate: 1, at: now },
    };
    const session = this.add(room, name);
    room.ownerId = room.hostId = session.memberId;
    this.rooms.set(room.id, room);
    return { snapshot: this.snapshot(room), session };
  }
  validateInvite(raw: string): Room {
    const key = hash(raw);
    const room = this.invites.get(key);
    const invite = room?.invites.get(key);
    if (
      !room ||
      room.closed ||
      !invite ||
      invite.expiresAt <= this.config.now() ||
      (invite.profile && !room.profileJoin)
    )
      throw new HttpError(410, "invite-expired");
    if (room.members.size >= this.config.maxSize) throw new HttpError(409, "room-full");
    return room;
  }
  join(raw: string, name: string): Envelope {
    const room = this.validateInvite(raw);
    const session = this.add(room, name);
    this.touch(room);
    return { snapshot: this.snapshot(room), session };
  }
  authenticate(raw: string) {
    const auth = this.sessions.get(hash(raw));
    if (!auth || auth.room.closed) throw new HttpError(401, "session-expired");
    if (!auth.member.connected) {
      auth.member.connected = true;
      this.touch(auth.room);
    }
    auth.member.lastSeen = this.config.now();
    return auth;
  }
  snapshot(room: Room): Snapshot {
    return {
      version: 1,
      roomId: room.id,
      revision: room.revision,
      epoch: room.epoch,
      sequence: room.sequence,
      ownerId: room.ownerId,
      hostId: room.hostId,
      hostReady: room.hostReady,
      maxSize: this.config.maxSize,
      profileJoin: room.profileJoin,
      skipMode: room.skipMode,
      skipQueue: room.skipQueue.map(command => ({ ...command })),
      closed: room.closed,
      playback: { ...room.playback, track: room.playback.track && { ...room.playback.track } },
      members: [...room.members.values()].map(({ tokenHash, lastSeen, ops, ...m }) => ({ ...m })),
      requests: [...room.requests],
      serverTime: this.config.now(),
    };
  }
  private touch(room: Room) {
    room.revision++;
    room.updatedAt = this.config.now();
    this.events.emit(room.id);
  }
  private host(room: Room, target: string) {
    const member = room.members.get(target);
    if (!member?.connected) throw new HttpError(409, "target-offline");
    room.playback = {
      ...room.playback,
      positionMs: positionAt(room.playback, this.config.now()),
      at: this.config.now(),
    };
    room.hostId = target;
    room.epoch++;
    room.sequence = 0;
    room.hostReady = false;
    room.skipQueue = [];
    member.ready = false;
    room.requests.delete(target);
  }
  private revoke(room: Room) {
    for (const key of room.invites.keys()) this.invites.delete(key);
    room.invites.clear();
  }
  private remove(room: Room, target: string) {
    const m = room.members.get(target);
    if (m) this.sessions.delete(m.tokenHash);
    room.members.delete(target);
    room.requests.delete(target);
  }
  close(room: Room) {
    room.closed = true;
    this.revoke(room);
    for (const m of room.members.values()) this.sessions.delete(m.tokenHash);
    this.touch(room);
    this.rooms.delete(room.id);
  }
  act(raw: string, action: Action): Envelope {
    const { room: r, member: m } = this.authenticate(raw);
    const fingerprint = JSON.stringify(action);
    const previous = m.ops.get(action.opId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new HttpError(409, "op-conflict");
      return previous.result;
    }
    const owner = () => {
      if (r.ownerId !== m.id) throw new HttpError(403, "owner-only");
    };
    const control = () => {
      if (r.ownerId !== m.id && r.hostId !== m.id) throw new HttpError(403, "host-only");
    };
    switch (action.type) {
      case "publish": {
        if (r.hostId !== m.id || action.epoch !== r.epoch || !r.hostReady)
          throw new HttpError(409, "stale-host");
        if (action.sequence <= r.sequence) throw new HttpError(409, "stale-sequence");
        const now = this.config.now();
        // Reject stale/future samples; never extrapolate an unbounded client clock.
        if (Math.abs(now - action.sampledAt) > 10_000) throw new HttpError(409, "stale-sample");
        const p = action.playback;
        if (
          (!p.track && (p.playing || p.positionMs !== 0)) ||
          (p.track && p.positionMs > p.track.durationMs + 1000)
        )
          throw new HttpError(400, "invalid-position");
        const positionMs = Math.min(
          p.track?.durationMs ?? 0,
          p.positionMs + (p.playing ? Math.max(0, now - action.sampledAt) : 0),
        );
        r.playback = { ...p, positionMs, at: now };
        r.sequence = action.sequence;
        break;
      }
      case "ready":
        if (action.epoch !== r.epoch) throw new HttpError(409, "stale-host");
        m.error = action.error;
        m.ready = !action.error;
        if (m.id === r.hostId) r.hostReady = m.ready;
        break;
      case "handoff":
        control();
        this.host(r, action.targetId);
        break;
      case "request":
        r.requests.add(m.id);
        break;
      case "decide":
        control();
        if (!r.requests.has(action.targetId)) throw new HttpError(409, "request-missing");
        r.requests.delete(action.targetId);
        if (action.accept) this.host(r, action.targetId);
        break;
      case "transferOwner":
        owner();
        if (!r.members.get(action.targetId)?.connected) throw new HttpError(409, "target-offline");
        r.ownerId = action.targetId;
        break;
      case "kick":
        owner();
        if (action.targetId === m.id) throw new HttpError(400, "cannot-kick-owner");
        if (!r.members.has(action.targetId)) throw new HttpError(404, "member-missing");
        this.remove(r, action.targetId);
        if (action.revokeInvites) this.revoke(r);
        if (r.hostId === action.targetId) this.host(r, m.id);
        break;
      case "invite": {
        owner();
        if (action.profile && !r.profileJoin) throw new HttpError(403, "profile-closed");
        if (r.invites.size >= this.config.maxInvites) throw new HttpError(429, "invite-limit");
        const invite = token();
        const key = hash(invite);
        const expiresAt =
          this.config.now() +
          Math.min(this.config.inviteTtlMs, action.profile ? 300_000 : this.config.inviteTtlMs);
        r.invites.set(key, { expiresAt, profile: action.profile });
        this.invites.set(key, r);
        this.touch(r);
        const result = { snapshot: this.snapshot(r), invite, expiresAt };
        m.ops.set(action.opId, { fingerprint, result });
        return result;
      }
      case "revokeInvites":
        owner();
        this.revoke(r);
        break;
      case "profileJoin":
        owner();
        r.profileJoin = action.enabled;
        this.revoke(r);
        break;
      case "rename":
        m.name = action.name;
        break;
      case "skipMode":
        owner();
        r.skipMode = action.mode;
        r.skipQueue = [];
        break;
      case "skip": {
        if (r.skipMode !== "everyone" && r.ownerId !== m.id)
          throw new HttpError(403, "owner-only");
        if (!r.members.get(r.hostId)?.connected || !r.hostReady)
          throw new HttpError(409, "host-not-ready");
        const now = this.config.now();
        if (now - r.lastSkipAt < 250 || r.skipQueue.length >= 4)
          throw new HttpError(429, "rate-limit");
        r.lastSkipAt = now;
        r.skipQueue.push({ id: ++r.skipSequence, direction: action.direction, epoch: r.epoch, expiresAt: now + 12_000 });
        break;
      }
      case "skipDone":
        if (r.hostId !== m.id || action.epoch !== r.epoch)
          throw new HttpError(409, "stale-host");
        if (r.skipQueue[0]?.id !== action.id) throw new HttpError(409, "skip-expired");
        r.skipQueue.shift();
        break;
      case "leave":
        if (r.ownerId === m.id) throw new HttpError(409, "transfer-owner-or-close");
        this.remove(r, m.id);
        if (r.hostId === m.id) {
          const next = r.members.get(r.ownerId)?.connected
            ? r.ownerId
            : [...r.members.values()].find((x) => x.connected)?.id;
          if (next) this.host(r, next);
          else {
            r.hostId = "";
            r.epoch++;
            r.sequence = 0;
            r.hostReady = false;
          }
        }
        break;
      case "close":
        owner();
        this.close(r);
        return { snapshot: this.snapshot(r) };
    }
    this.touch(r);
    const result = { snapshot: this.snapshot(r) };
    m.ops.set(action.opId, { fingerprint, result });
    while (m.ops.size > 128) m.ops.delete(m.ops.keys().next().value!);
    return result;
  }
  sweep() {
    const now = this.config.now();
    for (const r of this.rooms.values()) {
      if (
        now - r.updatedAt > this.config.roomTtlMs &&
        [...r.members.values()].every((m) => now - m.lastSeen > this.config.graceMs)
      ) {
        this.close(r);
        continue;
      }
      let changed = false;
      const pending = r.skipQueue.filter(command => command.expiresAt > now);
      if (pending.length !== r.skipQueue.length) { r.skipQueue = pending; changed = true; }
      for (const [key, invite] of r.invites)
        if (invite.expiresAt <= now) {
          r.invites.delete(key);
          this.invites.delete(key);
        }
      for (const m of r.members.values())
        if (m.connected && now - m.lastSeen > this.config.graceMs) {
          m.connected = false;
          m.ready = false;
          changed = true;
        }
      if (!r.members.get(r.hostId)?.connected) {
        const next = r.members.get(r.ownerId)?.connected
          ? r.members.get(r.ownerId)
          : [...r.members.values()]
              .filter((m) => m.connected)
              .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))[0];
        if (next && next.id !== r.hostId) {
          this.host(r, next.id);
          changed = true;
        } else if (r.hostReady) {
          r.hostReady = false;
          changed = true;
        }
      }
      if (changed) this.touch(r);
    }
  }
}
