/*
A small state machine that turns a stream of "Now Playing" snapshots into
listen records. Played time is accrued in small steps (each snapshot and each
tick), and any step longer than MAX_STEP_MS is thrown away: that only happens
when the Mac was asleep, and that time wasn't really listened to.
*/

import type { Snapshot } from "./media.ts";
import type { Store } from "./store.ts";

export const TICK_MS = 5_000;
const MAX_STEP_MS = 30_000;
// A paused track left alone this long is closed; pressing play afterwards
// starts a fresh listen.
const IDLE_CLOSE_MS = 30 * 60_000;
// Same track jumping back to its first seconds after real progress = a replay.
const REPLAY_START_SEC = 3;
const REPLAY_MIN_PROGRESS_SEC = 15;

type Active = {
  id: number;
  title: string;
  artist: string;
  album: string;
  durationMs: number | null;
  playedMs: number;
  playing: boolean;
  lastStepAt: number;
  lastPlayingAt: number;
  positionSec: number | null;
  positionAt: number;
};

export class Recorder {
  private active: Active | null = null;
  private readonly store: Store;
  private readonly isSource: (bundleId: string) => boolean;

  constructor(store: Store, sources: string[]) {
    this.store = store;
    const set = new Set(sources);
    this.isSource = (bundleId) => set.has(bundleId);
  }

  current(): Readonly<Active> | null {
    return this.active;
  }

  handle(snapshot: Snapshot | null, now: number) {
    this.step(now);

    const ours = snapshot && this.isSource(snapshot.bundleIdentifier) ? snapshot : null;
    if (!ours) {
      // Gap between tracks, app closed, or another app took over Now Playing.
      this.setPlaying(false, now);
      this.flush(now);
      return;
    }

    const active = this.active;
    if (active && isSameTrack(active, ours)) {
      if (isReplay(active, ours, now)) {
        this.close(now);
        if (ours.playing) this.start(ours, now);
        return;
      }
      this.absorbMetadata(active, ours);
      this.setPlaying(ours.playing, now);
      this.setPosition(ours, now);
      this.flush(now);
      return;
    }

    this.close(now);
    // A paused track sitting in the player (e.g. right after opening the app)
    // isn't a listen until it actually plays.
    if (ours.playing) this.start(ours, now);
  }

  tick(now: number) {
    if (!this.active) return;
    this.step(now);

    if (!this.active.playing && now - this.active.lastPlayingAt >= IDLE_CLOSE_MS) {
      this.close(now);
      return;
    }
    if (this.active.playing) this.flush(now);
  }

  stop(now: number) {
    this.step(now);
    this.close(now);
  }

  private step(now: number) {
    const active = this.active;
    if (!active) return;

    const delta = now - active.lastStepAt;
    if (active.playing && delta > 0 && delta <= MAX_STEP_MS) {
      active.playedMs += delta;
      active.lastPlayingAt = now;
    }
    active.lastStepAt = now;
  }

  private start(snapshot: Snapshot, now: number) {
    const durationMs = toMs(snapshot.durationSec);
    const id = this.store.startListen({
      title: snapshot.title,
      artist: snapshot.artist,
      album: snapshot.album,
      durationMs,
      startedAt: now,
      source: snapshot.bundleIdentifier,
    });
    this.active = {
      id,
      title: snapshot.title,
      artist: snapshot.artist,
      album: snapshot.album,
      durationMs,
      playedMs: 0,
      playing: true,
      lastStepAt: now,
      lastPlayingAt: now,
      positionSec: snapshot.elapsedSec,
      positionAt: now,
    };
  }

  private close(now: number) {
    if (!this.active) return;
    this.flush(now);
    this.store.updateListen(this.active.id, { open: false });
    this.active = null;
  }

  private flush(now: number) {
    const active = this.active;
    if (!active) return;
    this.store.updateListen(active.id, {
      title: active.title,
      artist: active.artist,
      album: active.album,
      durationMs: active.durationMs,
      playedMs: Math.round(active.playedMs),
      endedAt: active.playing ? now : active.lastPlayingAt,
    });
  }

  private setPlaying(playing: boolean, now: number) {
    const active = this.active;
    if (!active || active.playing === playing) return;
    // Freeze the extrapolated position so replay detection still works after
    // a pause or a blank snapshot.
    active.positionSec = positionNow(active, now);
    active.positionAt = now;
    if (!playing) active.lastPlayingAt = now;
    active.playing = playing;
  }

  private setPosition(snapshot: Snapshot, now: number) {
    const active = this.active;
    if (!active || snapshot.elapsedSec === null) return;
    active.positionSec = snapshot.elapsedSec;
    active.positionAt = now;
  }

  // YouTube Music often publishes the title first and fills in artist/album a
  // moment later, so blanks on the active listen are filled as they arrive.
  private absorbMetadata(active: Active, snapshot: Snapshot) {
    if (!active.artist && snapshot.artist) active.artist = snapshot.artist;
    if (snapshot.album) active.album = snapshot.album;
    const durationMs = toMs(snapshot.durationSec);
    if (durationMs) active.durationMs = durationMs;
  }
}

function isSameTrack(active: Active, snapshot: Snapshot) {
  if (active.title !== snapshot.title) return false;
  return !active.artist || !snapshot.artist || active.artist === snapshot.artist;
}

function isReplay(active: Active, snapshot: Snapshot, now: number) {
  if (snapshot.elapsedSec === null || active.positionSec === null) return false;
  if (snapshot.elapsedSec > REPLAY_START_SEC) return false;
  return (positionNow(active, now) ?? 0) >= REPLAY_MIN_PROGRESS_SEC;
}

// Where playback should be by now, given the last reported position.
// media-control only reports position on state changes, so we extrapolate.
function positionNow(active: Active, now: number): number | null {
  if (active.positionSec === null) return null;
  const sinceSec = active.playing ? (now - active.positionAt) / 1000 : 0;
  return active.positionSec + sinceSec;
}

function toMs(sec: number | null): number | null {
  return sec && sec > 0 ? Math.round(sec * 1000) : null;
}
