import type { Listen } from "./store.ts";
import { addDays, toDateKey } from "./time.ts";

const MIN_TRACK_MS = 30_000;
const ALWAYS_COUNTS_MS = 4 * 60_000;

// Last.fm's scrobble rule: the track is longer than 30s and was played for
// half its length or 4 minutes, whichever comes first. Without a known
// length, 30s of play is enough.
export function countsAsListen(listen: Pick<Listen, "playedMs" | "durationMs">): boolean {
  const { playedMs, durationMs } = listen;
  if (durationMs === null) return playedMs >= MIN_TRACK_MS;
  if (durationMs <= MIN_TRACK_MS) return false;
  return playedMs >= Math.min(durationMs / 2, ALWAYS_COUNTS_MS);
}

export type TrackStat = {
  title: string;
  artist: string;
  album: string;
  plays: number;
  playedMs: number;
  firstPlayedAt: number;
  lastPlayedAt: number;
};

export type ArtistStat = {
  artist: string;
  plays: number;
  playedMs: number;
  tracks: number;
};

export type Summary = {
  listens: number;
  skipped: number;
  // All audible time, including tracks that were skipped.
  playedMs: number;
  uniqueTracks: number;
  tracks: TrackStat[];
  artists: ArtistStat[];
};

export type DayStat = {
  date: string;
  listens: number;
  playedMs: number;
};

export type WeekSummary = Summary & { days: DayStat[] };

export function trackKey(listen: Pick<Listen, "title" | "artist">) {
  return `${listen.title.toLowerCase()}\u0000${listen.artist.toLowerCase()}`;
}

export function summarize(listens: Listen[]): Summary {
  const tracks = new Map<string, TrackStat>();
  const artists = new Map<string, ArtistStat & { keys: Set<string> }>();
  let counted = 0;
  let skipped = 0;
  let playedMs = 0;

  for (const listen of listens) {
    playedMs += listen.playedMs;
    if (!countsAsListen(listen)) {
      // The current track hasn't crossed the threshold yet; it isn't a skip.
      if (!listen.open) skipped += 1;
      continue;
    }
    counted += 1;

    const key = trackKey(listen);
    const track = tracks.get(key);
    if (track) {
      track.plays += 1;
      track.playedMs += listen.playedMs;
      track.lastPlayedAt = listen.startedAt;
      if (!track.album && listen.album) track.album = listen.album;
    } else {
      tracks.set(key, {
        title: listen.title,
        artist: listen.artist,
        album: listen.album,
        plays: 1,
        playedMs: listen.playedMs,
        firstPlayedAt: listen.startedAt,
        lastPlayedAt: listen.startedAt,
      });
    }

    const artistName = listen.artist || "Unknown artist";
    const artistKey = artistName.toLowerCase();
    const artist = artists.get(artistKey);
    if (artist) {
      artist.plays += 1;
      artist.playedMs += listen.playedMs;
      artist.keys.add(key);
    } else {
      artists.set(artistKey, {
        artist: artistName,
        plays: 1,
        playedMs: listen.playedMs,
        tracks: 0,
        keys: new Set([key]),
      });
    }
  }

  const byPlays = <T extends { plays: number; playedMs: number }>(a: T, b: T) =>
    b.plays - a.plays || b.playedMs - a.playedMs;

  return {
    listens: counted,
    skipped,
    playedMs,
    uniqueTracks: tracks.size,
    tracks: [...tracks.values()].sort(
      (a, b) => byPlays(a, b) || a.firstPlayedAt - b.firstPlayedAt
    ),
    artists: [...artists.values()]
      .map(({ keys, ...artist }) => ({ ...artist, tracks: keys.size }))
      .sort(byPlays),
  };
}

// `days` consecutive days ending with (and including) `lastDay`.
export function summarizeDays(listens: Listen[], lastDay: Date, days: number): WeekSummary {
  const firstDay = addDays(lastDay, -(days - 1));
  const buckets = new Map<string, Listen[]>();
  for (let i = 0; i < days; i++) buckets.set(toDateKey(addDays(firstDay, i)), []);

  for (const listen of listens) {
    buckets.get(toDateKey(new Date(listen.startedAt)))?.push(listen);
  }

  const dayStats = [...buckets.entries()].map(([date, dayListens]) => {
    const summary = summarize(dayListens);
    return { date, listens: summary.listens, playedMs: summary.playedMs };
  });

  return { ...summarize(listens), days: dayStats };
}
