import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parsePayload } from "../src/media.ts";
import { countsAsListen, summarize, summarizeDays } from "../src/stats.ts";
import type { Listen } from "../src/store.ts";
import { formatDuration, parseDay } from "../src/time.ts";

let nextId = 1;
function listen(overrides: Partial<Listen> = {}): Listen {
  return {
    id: nextId++,
    title: "Feel It Still",
    artist: "Portugal. The Man",
    album: "",
    durationMs: 163_000,
    startedAt: new Date(2026, 9, 10, 10, 0).getTime(),
    endedAt: new Date(2026, 9, 10, 10, 3).getTime(),
    playedMs: 163_000,
    source: "app",
    open: false,
    ...overrides,
  };
}

describe("countsAsListen", () => {
  test("half the track counts", () => {
    assert.equal(countsAsListen({ durationMs: 200_000, playedMs: 100_000 }), true);
    assert.equal(countsAsListen({ durationMs: 200_000, playedMs: 99_000 }), false);
  });

  test("4 minutes counts for long tracks", () => {
    assert.equal(countsAsListen({ durationMs: 20 * 60_000, playedMs: 4 * 60_000 }), true);
  });

  test("tracks of 30s or less never count", () => {
    assert.equal(countsAsListen({ durationMs: 30_000, playedMs: 30_000 }), false);
  });

  test("unknown length needs 30s", () => {
    assert.equal(countsAsListen({ durationMs: null, playedMs: 30_000 }), true);
    assert.equal(countsAsListen({ durationMs: null, playedMs: 29_000 }), false);
  });
});

describe("summarize", () => {
  test("groups repeats, counts skips, and sums all played time", () => {
    const summary = summarize([
      listen(),
      listen({ title: "Speed of Sound", artist: "Coldplay", durationMs: 288_000, playedMs: 10_000 }),
      listen(),
      listen({ title: "Wish You Were Here", artist: "Pink Floyd", durationMs: 334_000, playedMs: 334_000 }),
    ]);

    assert.equal(summary.listens, 3);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.playedMs, 163_000 * 2 + 10_000 + 334_000);
    assert.deepEqual(
      summary.tracks.map((t) => [t.title, t.plays]),
      [
        ["Feel It Still", 2],
        ["Wish You Were Here", 1],
      ]
    );
    assert.deepEqual(
      summary.artists.map((a) => [a.artist, a.plays, a.tracks]),
      [
        ["Portugal. The Man", 2, 1],
        ["Pink Floyd", 1, 1],
      ]
    );
  });

  test("the track still playing isn't a skip", () => {
    const summary = summarize([listen({ playedMs: 5_000, open: true })]);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.listens, 0);
  });
});

describe("summarizeDays", () => {
  test("buckets listens into 7 local days ending on the given day", () => {
    const lastDay = new Date(2026, 9, 10);
    const week = summarizeDays(
      [
        listen({ startedAt: new Date(2026, 9, 4, 23, 59).getTime() }),
        listen({ startedAt: new Date(2026, 9, 10, 0, 1).getTime() }),
        listen({ startedAt: new Date(2026, 9, 10, 9, 0).getTime() }),
      ],
      lastDay,
      7
    );

    assert.equal(week.days.length, 7);
    assert.equal(week.days[0]?.date, "2026-10-04");
    assert.equal(week.days[0]?.listens, 1);
    assert.equal(week.days[6]?.date, "2026-10-10");
    assert.equal(week.days[6]?.listens, 2);
    assert.equal(week.listens, 3);
  });
});

describe("parsePayload", () => {
  test("reads a media-control payload", () => {
    assert.deepEqual(
      parsePayload({
        bundleIdentifier: "app",
        title: " Feel It Still ",
        artist: "Portugal. The Man",
        album: "",
        playing: true,
        elapsedTime: 3.1,
        duration: 163.2,
      }),
      {
        bundleIdentifier: "app",
        title: "Feel It Still",
        artist: "Portugal. The Man",
        album: "",
        playing: true,
        elapsedSec: 3.1,
        durationSec: 163.2,
      }
    );
  });

  test("blank payloads between tracks are null", () => {
    assert.equal(parsePayload({}), null);
    assert.equal(parsePayload(null), null);
    assert.equal(parsePayload({ bundleIdentifier: "app", title: "" }), null);
  });
});

describe("time helpers", () => {
  test("formatDuration", () => {
    assert.equal(formatDuration(45_000), "45s");
    assert.equal(formatDuration(12 * 60_000), "12m");
    assert.equal(formatDuration(65 * 60_000), "1h 05m");
  });

  test("parseDay", () => {
    const now = new Date(2026, 9, 10, 15, 0);
    assert.equal(parseDay("yesterday", now).getDate(), 9);
    assert.equal(parseDay("2026-02-28", now).getMonth(), 1);
    assert.throws(() => parseDay("2026-02-30", now));
  });
});
