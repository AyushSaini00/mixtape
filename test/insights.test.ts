import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  currentStreak,
  dailyTotals,
  longestStreak,
  monthPeriod,
  monthRows,
  recordedDays,
  wrapped,
  yearPeriod,
} from "../src/insights.ts";
import { trackKey } from "../src/stats.ts";
import type { Listen } from "../src/store.ts";

const FEEL = { title: "Feel It Still", artist: "Portugal. The Man", durationMs: 163_000 };
const SPEED = { title: "Speed of Sound", artist: "Coldplay", durationMs: 288_000 };
const WISH = { title: "Wish You Were Here", artist: "Pink Floyd", durationMs: 334_000 };

let nextId = 1;
// A full play of `song` on 2026-<month+1>-<day> at `hour`:00.
function play(
  song: typeof FEEL,
  month: number,
  day: number,
  hour = 10,
  overrides: Partial<Listen> = {}
): Listen {
  const startedAt = new Date(2026, month, day, hour).getTime();
  return {
    id: nextId++,
    album: "",
    startedAt,
    endedAt: startedAt + song.durationMs,
    playedMs: song.durationMs,
    source: "app",
    open: false,
    ...song,
    ...overrides,
  };
}

const SEP = 8;
const OCT = 9;

describe("streaks", () => {
  const totals = dailyTotals([
    play(FEEL, SEP, 28),
    play(FEEL, SEP, 29),
    play(SPEED, SEP, 30),
    play(WISH, OCT, 1),
    // a skip only: doesn't keep a streak alive
    play(FEEL, OCT, 2, 10, { playedMs: 5_000 }),
    play(FEEL, OCT, 4),
    play(SPEED, OCT, 5),
  ]);

  test("current streak includes today", () => {
    assert.deepEqual(currentStreak(totals, new Date(2026, OCT, 5, 20)), {
      days: 2,
      from: "2026-10-04",
      to: "2026-10-05",
    });
  });

  test("current streak survives until a full day passes without music", () => {
    assert.equal(currentStreak(totals, new Date(2026, OCT, 6, 9)).days, 2);
    assert.equal(currentStreak(totals, new Date(2026, OCT, 7, 9)).days, 0);
  });

  test("longest streak within a range", () => {
    assert.deepEqual(longestStreak(totals, new Date(2026, SEP, 1), new Date(2026, OCT, 31)), {
      days: 4,
      from: "2026-09-28",
      to: "2026-10-01",
    });
    assert.equal(longestStreak(totals, new Date(2026, OCT, 1), new Date(2026, OCT, 31)).days, 2);
  });
});

describe("monthRows", () => {
  test("blank cells before recording started and after today", () => {
    const totals = dailyTotals([play(FEEL, SEP, 3), play(SPEED, SEP, 3), play(WISH, OCT, 1)]);
    const rows = monthRows(totals, new Date(2026, 7, 1), new Date(2026, OCT, 1), new Date(2026, SEP, 3), new Date(2026, OCT, 2));

    // August ends before recording started, so it's left out.
    assert.deepEqual(rows.map((row) => row.month), ["2026-09-01", "2026-10-01"]);
    const [sep, oct] = rows;
    assert.equal(sep?.days.length, 30);
    assert.deepEqual(sep?.days.slice(0, 4), [null, null, 451_000, 0]);
    assert.equal(sep?.activeDays, 1);
    assert.equal(sep?.playedMs, 451_000);
    assert.deepEqual(oct?.days.slice(0, 3), [334_000, 0, null]);
  });
});

describe("recordedDays", () => {
  test("clips the period to recording start and today", () => {
    const sep = monthPeriod(2026, SEP);
    assert.equal(recordedDays(sep, new Date(2026, 0, 1), new Date(2026, OCT, 10)), 30);
    assert.equal(recordedDays(sep, new Date(2026, SEP, 21), new Date(2026, OCT, 10)), 10);
    assert.equal(recordedDays(monthPeriod(2026, OCT), new Date(2026, 0, 1), new Date(2026, OCT, 10)), 10);
    assert.equal(recordedDays(monthPeriod(2026, 7), new Date(2026, SEP, 1), new Date(2026, OCT, 10)), 0);
  });
});

describe("wrapped", () => {
  const listens = [
    play(FEEL, SEP, 15, 10),
    play(FEEL, SEP, 15, 11),
    play(FEEL, SEP, 15, 12),
    play(SPEED, SEP, 15, 19),
    play(SPEED, SEP, 16, 10, { playedMs: 10_000 }),
    play(SPEED, SEP, 17, 10, { playedMs: 12_000 }),
    play(WISH, SEP, 17, 22),
  ];
  const previousListens = [play(FEEL, 7, 20)];
  const base = {
    period: monthPeriod(2026, SEP),
    listens,
    previousListens,
    priorTracks: new Set(previousListens.map(trackKey)),
    recordedFrom: new Date(2026, 0, 1),
    today: new Date(2026, OCT, 10),
  };

  test("headline numbers and highlights", () => {
    const recap = wrapped(base);

    assert.equal(recap.from, "2026-09-01");
    assert.equal(recap.to, "2026-09-30");
    assert.equal(recap.partial, false);
    assert.equal(recap.recordedDays, 30);
    assert.equal(recap.summary.listens, 5);
    assert.equal(recap.activeDays, 2);
    assert.deepEqual(recap.onRepeat, { title: "Feel It Still", artist: "Portugal. The Man", plays: 3, date: "2026-09-15" });
    assert.deepEqual(recap.biggestDay, { date: "2026-09-15", playedMs: 163_000 * 3 + 288_000 });
    assert.deepEqual(recap.mostSkipped, { title: "Speed of Sound", artist: "Coldplay", skips: 2 });
    assert.equal(recap.discoveries, 2);
    assert.equal(recap.longestStreak.days, 1);
  });

  test("listening time by 3-hour block", () => {
    const recap = wrapped(base);
    assert.deepEqual(
      recap.hours.map((block) => [block.hour, block.playedMs]),
      [
        [9, 163_000 * 2 + 10_000 + 12_000],
        [12, 163_000],
        [18, 288_000],
        [21, 334_000],
      ]
    );
    const total = recap.hours.reduce((sum, block) => sum + block.share, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
  });

  test("change per day compares against the previous period", () => {
    const recap = wrapped(base);
    const perDay = recap.summary.playedMs / 30;
    const previousPerDay = 163_000 / 31;
    assert.ok(Math.abs((recap.changeVsPrevious ?? 0) - (perDay / previousPerDay - 1)) < 1e-9);
    assert.equal(wrapped({ ...base, previousListens: [] }).changeVsPrevious, null);
  });

  test("no discoveries count when recording started inside the period", () => {
    const recap = wrapped({ ...base, recordedFrom: new Date(2026, SEP, 10) });
    assert.equal(recap.startedMidPeriod, true);
    assert.equal(recap.discoveries, null);
    assert.equal(recap.recordedDays, 21);
  });

  test("the current month is partial", () => {
    const recap = wrapped({ ...base, period: monthPeriod(2026, OCT), listens: [play(WISH, OCT, 2)] });
    assert.equal(recap.partial, true);
    assert.equal(recap.recordedDays, 10);
    assert.equal(recap.onRepeat, null);
  });

  test("a year period", () => {
    const recap = wrapped({ ...base, period: yearPeriod(2026) });
    assert.equal(recap.from, "2026-01-01");
    assert.equal(recap.to, "2026-12-31");
    assert.equal(recap.partial, true);
  });
});
