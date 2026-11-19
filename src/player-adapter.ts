import type { AddonApi } from "@pulsesync/addon-sdk";
import type { PulseSyncPlayerSnapshot } from "@pulsesync/yamusic-types";
import { trackSchema, type Playback, type Track } from "../shared/protocol.js";

export type LocalPlayback = Playback & { ready: boolean };
export interface PlayerAdapter {
  read(): Promise<LocalPlayback>;
  load(track: Track): Promise<void>;
  seek(ms: number): Promise<void>;
  playing(value: boolean): Promise<void>;
  skip?(direction: "next" | "previous"): Promise<void>;
  subscribe?(wake: () => void): () => void;
}
export function fromSnapshot(snapshot: PulseSyncPlayerSnapshot): LocalPlayback {
  const t = snapshot.track;
  const coverUri = t?.coverUri?.replace("%%", "200x200") ?? "";
  const cover = coverUri
    ? coverUri.startsWith("https://")
      ? coverUri
      : "https://" + coverUri
    : "";
  const parsed = t
    ? trackSchema.safeParse({
        trackId: String(t.id),
        albumId: t.albums?.[0]?.id ? String(t.albums[0].id) : undefined,
        title: t.title ?? "",
        artist: t.artists?.map((a) => a.name).join(", ") ?? "",
        durationMs: Number(t.duration ?? t.durationMs ?? 0),
        cover: /^https:\/\/avatars\.(mds\.yandex\.net|yandex\.net)\//.test(cover) ? cover : "",
      })
    : null;
  return {
    track: parsed?.success ? parsed.data : null,
    playing: snapshot.isPlaying,
    positionMs: Math.max(
      0,
      (typeof snapshot.progress === "number"
        ? snapshot.progress
        : (snapshot.progress?.position ?? 0)) * 1000,
    ),
    rate: 1,
    ready: ["playing", "paused"].includes(snapshot.status),
  };
}
export function sdkPlayer(api: AddonApi): PlayerAdapter {
  return {
    read: async () => fromSnapshot(await api.player.getSnapshot()),
    load: (t) =>
      api.client.playTrackById(t.trackId, t.albumId ? { albumId: t.albumId } : undefined),
    seek: (ms) => api.client.setProgress(ms / 1000),
    skip: (direction) => direction === "next" ? api.client.next() : api.client.previous(),
    subscribe: (wake) => {
      if (!api.player.onChange) return () => {};
      let previous: { track: string; playing: boolean; position: number; at: number } | undefined;
      return api.player.onChange(snapshot => {
        const local = fromSnapshot(snapshot);
        const now = performance.now();
        const track = local.track?.trackId ?? "";
        if (!previous || track !== previous.track || local.playing !== previous.playing ||
          Math.abs(local.positionMs - previous.position - (previous.playing ? now - previous.at : 0)) > 250)
          wake();
        previous = { track, playing: local.playing, position: local.positionMs, at: now };
      });
    },
    // Runtime play/pause are toggles; read immediately before changing the state.
    playing: async (value) => {
      const s = await api.player.getSnapshot();
      if (s.isPlaying !== value) await api.client.togglePlayPause();
    },
  };
}
