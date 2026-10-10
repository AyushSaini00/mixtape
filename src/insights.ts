/*
Longer-range views over the listen history: per-day totals, streaks, the
month-by-month strips behind `mixtape year`, and the `mixtape wrapped` recap.
All pure functions over Listen rows; rendering lives in cli.ts.
*/

import { countsAsListen, summarize, trackKey, type Summary } from "./stats.ts";
import type { Listen } from "./store.ts";
import { addDays, startOfDay, toDateKey } from "./time.ts";

export type DayTotal = {
  date: string;
  // All audible time, skips included.
  playedMs: number;
  // Plays that count as listens.
  listens: number;
};

export function dailyTotals(listens: Listen[]): Map<string, DayTotal> {
  const days = new Map<string, DayTotal>();
  for (const listen of listens) {
    const date = toDateKey(new Date(listen.startedAt));
    const day = days.get(date) ?? { date, playedMs: 0, listens: 0 };
    day.playedMs += listen.playedMs;
    if (countsAsListen(listen)) day.listens += 1;
    days.set(date, day);
  }
  return days;
}

export type Streak = { days: number; from: string | null; to: string | null };

// A day counts toward a streak if it has at least one listen.
function isActive(totals: Map<string, DayTotal>, date: string) {
  return (totals.get(date)?.listens ?? 0) > 0;
}

// Consecutive days with music, ending today. A streak isn't broken until a
// whole day passes without music, so it's still alive this morning if
// yesterday had music.
export function currentStreak(totals: Map<string, DayTotal>, today: Date): Streak {
  let day = startOfDay(today);
  if (!isActive(totals, toDateKey(day))) day = addDays(day, -1);
  if (!isActive(totals, toDateKey(day))) return { days: 0, from: null, to: null };

  const to = toDateKey(day);
  let days = 0;
  let from = to;
  while (isActive(totals, toDateKey(day))) {
    days += 1;
    from = toDateKey(day);
    day = addDays(day, -1);
  }
  return { days, from, to };
}

// Longest run of days with music between `first` and `last` (inclusive).
export function longestStreak(totals: Map<string, DayTotal>, first: Date, last: Date): Streak {
  let best: Streak = { days: 0, from: null, to: null };
  let run = 0;
  let runFrom: string | null = null;

  for (let day = startOfDay(first); day <= last; day = addDays(day, 1)) {
    const date = toDateKey(day);
    if (!isActive(totals, date)) {
      run = 0;
      continue;
    }
    if (run === 0) runFrom = date;
    run += 1;
    if (run > best.days) best = { days: run, from: runFrom, to: date };
  }
  return best;
}

export type MonthRow = {
  // First day of the month.
  month: string;
  // Played time per day of the month; null for days outside recorded history
  // (before recording started, or still in the future).
  days: (number | null)[];
  playedMs: number;
  activeDays: number;
};

// One row per month from `firstMonth` through `lastMonth`, skipping months
// that end before recording started.
export function monthRows(
  totals: Map<string, DayTotal>,
  firstMonth: Date,
  lastMonth: Date,
  recordedFrom: Date,
  today: Date
): MonthRow[] {
  const rows: MonthRow[] = [];
  const first = startOfDay(recordedFrom);
  const last = startOfDay(today);

  for (
    let month = new Date(firstMonth.getFullYear(), firstMonth.getMonth(), 1);
    month <= lastMonth;
    month = new Date(month.getFullYear(), month.getMonth() + 1, 1)
  ) {
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const monthEnd = new Date(month.getFullYear(), month.getMonth(), daysInMonth);
    if (monthEnd < first) continue;

    const row: MonthRow = { month: toDateKey(month), days: [], playedMs: 0, activeDays: 0 };
    for (let d = 1; d <= daysInMonth; d++) {
      const day = new Date(month.getFullYear(), month.getMonth(), d);
      if (day < first || day > last) {
        row.days.push(null);
        continue;
      }
      const total = totals.get(toDateKey(day));
      row.days.push(total?.playedMs ?? 0);
      row.playedMs += total?.playedMs ?? 0;
      if (isActive(totals, toDateKey(day))) row.activeDays += 1;
    }
    rows.push(row);
  }
  return rows;
}

export type Period = {
  kind: "month" | "year";
  start: Date;
  // Exclusive.
  end: Date;
};

export function monthPeriod(year: number, month: number): Period {
  return { kind: "month", start: new Date(year, month, 1), end: new Date(year, month + 1, 1) };
}

export function yearPeriod(year: number): Period {
  return { kind: "year", start: new Date(year, 0, 1), end: new Date(year + 1, 0, 1) };
}

export function previousPeriod(period: Period): Period {
  const { start } = period;
  return period.kind === "month"
    ? monthPeriod(start.getFullYear(), start.getMonth() - 1)
    : yearPeriod(start.getFullYear() - 1);
}

// Days of `period` that mixtape could have recorded: from recording start
// (or the period start) up to today (or the period end).
export function recordedDays(period: Period, recordedFrom: Date, today: Date): number {
  const from = Math.max(period.start.getTime(), startOfDay(recordedFrom).getTime());
  const to = Math.min(period.end.getTime(), addDays(startOfDay(today), 1).getTime());
  if (to <= from) return 0;
  return Math.round((to - from) / 86_400_000);
}

export type Wrapped = {
  from: string;
  to: string;
  partial: boolean;
  recordedDays: number;
  // Recording started after the period began, so it isn't the full picture.
  startedMidPeriod: boolean;
  summary: Summary;
  activeDays: number;
  // Average listening time on days with music.
  perActiveDayMs: number;
  // Change in listening time per recorded day vs the previous period, as a
  // fraction (0.12 = 12% more). Null when there's nothing to compare with.
  changeVsPrevious: number | null;
  onRepeat: { title: string; artist: string; plays: number; date: string } | null;
  biggestDay: { date: string; playedMs: number } | null;
  // Listening time in 3-hour blocks starting at `hour`.
  hours: { hour: number; playedMs: number; share: number }[];
  // Songs played for the first time ever. Null if recording started inside
  // the period, since then every song would look new.
  discoveries: number | null;
  mostSkipped: { title: string; artist: string; skips: number } | null;
  longestStreak: Streak;
};

export type WrappedInput = {
  period: Period;
  listens: Listen[];
  previousListens: Listen[];
  // trackKey() of every song played before the period started.
  priorTracks: Set<string>;
  recordedFrom: Date;
  today: Date;
};

export function wrapped(input: WrappedInput): Wrapped {
  const { period, listens, previousListens, priorTracks, recordedFrom, today } = input;
  const summary = summarize(listens);
  const totals = dailyTotals(listens);
  const days = recordedDays(period, recordedFrom, today);

  const lastDay = new Date(Math.min(addDays(period.end, -1).getTime(), startOfDay(today).getTime()));
  const activeDays = [...totals.values()].filter((day) => day.listens > 0).length;

  const previous = previousPeriod(period);
  const previousDays = recordedDays(previous, recordedFrom, today);
  const previousMs = previousListens.reduce((sum, l) => sum + l.playedMs, 0);
  const changeVsPrevious =
    previousDays > 0 && previousMs > 0 && days > 0
      ? summary.playedMs / days / (previousMs / previousDays) - 1
      : null;

  // Most plays of one song within a single day.
  const perDayTrack = new Map<string, { title: string; artist: string; plays: number; date: string }>();
  for (const listen of listens) {
    if (!countsAsListen(listen)) continue;
    const date = toDateKey(new Date(listen.startedAt));
    const key = `${date}\u0000${trackKey(listen)}`;
    const entry = perDayTrack.get(key) ?? { title: listen.title, artist: listen.artist, plays: 0, date };
    entry.plays += 1;
    perDayTrack.set(key, entry);
  }
  const repeat = [...perDayTrack.values()].sort((a, b) => b.plays - a.plays || a.date.localeCompare(b.date))[0];

  const biggest = [...totals.values()].sort((a, b) => b.playedMs - a.playedMs)[0];

  const blocks = Array.from({ length: 8 }, (_, i) => ({ hour: i * 3, playedMs: 0, share: 0 }));
  for (const listen of listens) {
    blocks[Math.floor(new Date(listen.startedAt).getHours() / 3)]!.playedMs += listen.playedMs;
  }
  for (const block of blocks) block.share = summary.playedMs > 0 ? block.playedMs / summary.playedMs : 0;

  const startedMidPeriod = startOfDay(recordedFrom) > period.start;
  const discoveries = startedMidPeriod
    ? null
    : summary.tracks.filter((track) => !priorTracks.has(trackKey(track))).length;

  const skips = new Map<string, { title: string; artist: string; skips: number }>();
  for (const listen of listens) {
    if (listen.open || countsAsListen(listen)) continue;
    const key = trackKey(listen);
    const entry = skips.get(key) ?? { title: listen.title, artist: listen.artist, skips: 0 };
    entry.skips += 1;
    skips.set(key, entry);
  }
  const skipped = [...skips.values()].sort((a, b) => b.skips - a.skips)[0];

  return {
    from: toDateKey(period.start),
    to: toDateKey(addDays(period.end, -1)),
    partial: period.end > addDays(startOfDay(today), 1),
    recordedDays: days,
    startedMidPeriod,
    summary,
    activeDays,
    perActiveDayMs: activeDays > 0 ? summary.playedMs / activeDays : 0,
    changeVsPrevious,
    onRepeat: repeat && repeat.plays >= 2 ? repeat : null,
    biggestDay: biggest && biggest.playedMs > 0 ? { date: biggest.date, playedMs: biggest.playedMs } : null,
    hours: blocks.filter((block) => block.playedMs > 0),
    discoveries,
    mostSkipped: skipped && skipped.skips >= 2 ? skipped : null,
    longestStreak: longestStreak(totals, period.start, lastDay),
  };
}
