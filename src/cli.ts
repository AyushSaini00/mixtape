import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { runDaemon, runningDaemonPid } from "./daemon.ts";
import { bar, bold, cyan, dim, green, padEnd, padStart, red, table, truncate, yellow } from "./format.ts";
import { findMediaControl, getNowPlaying, sourceBundleIds, YT_MUSIC_PWA_BUNDLE_ID } from "./media.ts";
import { dbPath, logPath } from "./paths.ts";
import {
  BREW_SERVICE_LABEL,
  installService,
  isLoaded,
  plistPath,
  SERVICE_LABEL,
  uninstallService,
} from "./service.ts";
import {
  currentStreak,
  dailyTotals,
  longestStreak,
  monthPeriod,
  monthRows,
  previousPeriod,
  wrapped,
  yearPeriod,
  type MonthRow,
  type Streak,
} from "./insights.ts";
import { countsAsListen, summarize, summarizeDays, trackKey } from "./stats.ts";
import { Store } from "./store.ts";
import {
  addDays,
  formatClock,
  formatDay,
  formatDuration,
  formatDateRange,
  formatMonthLong,
  formatMonthShort,
  formatPosition,
  fromDateKey,
  parseDay,
  startOfDay,
  toDateKey,
} from "./time.ts";

const HELP = `${bold("mixtape")} — your YouTube Music listening habits, from the terminal

${bold("Usage")}
  mixtape [today]          Listens, listening time and songs played today
  mixtape week             The last 7 days: per-day totals, top tracks and artists
  mixtape log              Every play today, in order (including skips)
  mixtape year             Month-by-month listening for the last 12 months, plus streaks
  mixtape wrapped          A recap of this month so far: top songs, artists and highlights
  mixtape now              What's playing right now
  mixtape status           Is the recorder running? Where is the data?

  mixtape daemon           Run the recorder in the foreground
  mixtape service install  Run the recorder in the background at login
  mixtape service uninstall

${bold("Options")}
  -d, --date <day>         YYYY-MM-DD, "today" or "yesterday" (for week: the last day)
      --month <YYYY-MM>    For wrapped: a specific month
      --year <YYYY>        For wrapped and year: a calendar year
      --json               Print raw data as JSON
  -h, --help               Show this help
  -v, --version            Show the version

A play counts as a listen once you've heard half the track or 4 minutes,
whichever comes first (tracks of 30s or less never count).
`;

function version(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { version: string };
  return pkg.version;
}

function tildify(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function dayLabel(day: Date): string {
  const today = startOfDay(new Date());
  if (day.getTime() === today.getTime()) return `Today · ${formatDay(day)}`;
  if (day.getTime() === addDays(today, -1).getTime()) return `Yesterday · ${formatDay(day)}`;
  return formatDay(day);
}

function trackLabel(title: string, artist: string): string {
  return artist ? `${title} — ${artist}` : title;
}

function recorderHint(): string | null {
  if (runningDaemonPid() !== null) return null;
  return yellow(
    "  The recorder isn't running, so new plays aren't being saved.\n" +
      "  Start it with `mixtape service install` (or `brew services start mixtape` for Homebrew installs)."
  );
}

function printLines(lines: (string | null | false)[]) {
  console.log(lines.filter((line) => line !== null && line !== false).join("\n"));
}

function openStore(): Store {
  return new Store(dbPath());
}

function listensForDay(store: Store, day: Date) {
  return store.listensBetween(day.getTime(), addDays(day, 1).getTime());
}

function cmdToday(day: Date, json: boolean) {
  const store = openStore();
  const listens = listensForDay(store, day);
  const history = store.listensBetween(0, addDays(day, 1).getTime());
  store.close();
  const summary = summarize(listens);
  const streak = currentStreak(dailyTotals(history), day);

  if (json) {
    console.log(JSON.stringify({ date: toDateKey(day), ...summary, streak }, null, 2));
    return;
  }

  const stats = [
    `${bold(String(summary.listens))} ${summary.listens === 1 ? "listen" : "listens"}`,
    `${bold(formatDuration(summary.playedMs))} listened`,
    summary.skipped > 0 && `${summary.skipped} skipped`,
    streak.days >= 2 && `${streak.days}-day streak`,
  ].filter(Boolean);

  const rows = summary.tracks.map((track, i) => [
    String(i + 1),
    track.title,
    track.artist,
    String(track.plays),
    formatDuration(track.playedMs),
  ]);

  printLines([
    "",
    `  ${bold(dayLabel(day))}`,
    "",
    `  ${stats.join(dim("  ·  "))}`,
    "",
    rows.length > 0
      ? table(
          [
            { header: "#", align: "right", style: dim },
            { header: "Track", flex: true },
            { header: "Artist", flex: false, style: dim },
            { header: "Plays", align: "right", style: cyan },
            { header: "Time", align: "right", style: dim },
          ],
          rows
        )
      : dim("  Nothing listened to yet. Play something in YouTube Music."),
    "",
    recorderHint(),
  ]);
}

function cmdWeek(lastDay: Date, json: boolean) {
  const days = 7;
  const firstDay = addDays(lastDay, -(days - 1));
  const store = openStore();
  const listens = store.listensBetween(firstDay.getTime(), addDays(lastDay, 1).getTime());
  store.close();
  const week = summarizeDays(listens, lastDay, days);

  if (json) {
    console.log(
      JSON.stringify({ from: toDateKey(firstDay), to: toDateKey(lastDay), ...week }, null, 2)
    );
    return;
  }

  const maxMs = Math.max(0, ...week.days.map((day) => day.playedMs));
  const dayRows = week.days.map((day, i) => {
    const date = addDays(firstDay, i);
    const label = `${formatDay(date).split(" ").slice(0, 2).join(" ")}`;
    const isToday = toDateKey(date) === toDateKey(new Date());
    return [
      "  " + padEnd(isToday ? bold(label) : label, 7),
      bar(day.playedMs, maxMs, 24),
      padStart(String(day.listens), 4),
      dim(day.listens === 1 ? "listen " : "listens"),
      padStart(day.playedMs > 0 ? formatDuration(day.playedMs) : dim("–"), 7),
    ].join("  ");
  });

  const stats = [
    `${bold(String(week.listens))} listens`,
    `${bold(formatDuration(week.playedMs))} listened`,
    `${week.uniqueTracks} tracks`,
    week.skipped > 0 && `${week.skipped} skipped`,
  ].filter(Boolean);

  const topTracks = week.tracks.slice(0, 10).map((track, i) => [
    String(i + 1),
    track.title,
    track.artist,
    String(track.plays),
    formatDuration(track.playedMs),
  ]);
  const topArtists = week.artists.slice(0, 5).map((artist, i) => [
    String(i + 1),
    artist.artist,
    String(artist.tracks),
    String(artist.plays),
    formatDuration(artist.playedMs),
  ]);

  printLines([
    "",
    `  ${bold("Last 7 days")} ${dim(`· ${formatDay(firstDay)} – ${formatDay(lastDay)}`)}`,
    "",
    ...dayRows,
    "",
    `  ${stats.join(dim("  ·  "))}`,
    ...(topTracks.length > 0
      ? [
          "",
          `  ${bold("Top tracks")}`,
          table(
            [
              { header: "#", align: "right", style: dim },
              { header: "Track", flex: true },
              { header: "Artist", style: dim },
              { header: "Plays", align: "right", style: cyan },
              { header: "Time", align: "right", style: dim },
            ],
            topTracks
          ),
          "",
          `  ${bold("Top artists")}`,
          table(
            [
              { header: "#", align: "right", style: dim },
              { header: "Artist", flex: true },
              { header: "Tracks", align: "right", style: dim },
              { header: "Plays", align: "right", style: cyan },
              { header: "Time", align: "right", style: dim },
            ],
            topArtists
          ),
        ]
      : []),
    "",
    recorderHint(),
  ]);
}

function cmdLog(day: Date, json: boolean) {
  const store = openStore();
  const listens = listensForDay(store, day);
  store.close();

  if (json) {
    console.log(
      JSON.stringify(
        { date: toDateKey(day), plays: listens.map((l) => ({ ...l, counted: countsAsListen(l) })) },
        null,
        2
      )
    );
    return;
  }

  const rows = listens.map((listen) => {
    const counted = countsAsListen(listen);
    const note = listen.open ? green("▶ now") : counted ? "" : dim("skipped");
    return [formatClock(listen.startedAt), listen.title, listen.artist, formatDuration(listen.playedMs), note];
  });

  printLines([
    "",
    `  ${bold(dayLabel(day))} ${dim(`· ${listens.length} ${listens.length === 1 ? "play" : "plays"}`)}`,
    "",
    rows.length > 0
      ? table(
          [
            { header: "Time", style: dim },
            { header: "Track", flex: true },
            { header: "Artist", style: dim },
            { header: "Played", align: "right" },
            { header: "" },
          ],
          rows
        )
      : dim("  Nothing played yet."),
    "",
    recorderHint(),
  ]);
}

// The month-by-month strips: one row per month, one cell per day, shaded by
// listening time.
const SHADES: [number, string][] = [
  [15 * 60_000, "░"],
  [30 * 60_000, "▒"],
  [60 * 60_000, "▓"],
];
const STRIP_LABEL_WIDTH = 9;

function shade(playedMs: number | null): string {
  if (playedMs === null) return " ";
  if (playedMs <= 0) return dim("·");
  for (const [limit, char] of SHADES) if (playedMs < limit) return green(char);
  return green("█");
}

function daysLabel(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

function renderStrips(rows: MonthRow[]): string[] {
  const ruler = [1, 5, 10, 15, 20, 25, 30].reduce(
    (line, day) => line + " ".repeat(day - 1 - line.length) + day,
    ""
  );
  const lines = [dim(`  ${" ".repeat(STRIP_LABEL_WIDTH)} ${ruler}`)];
  rows.forEach((row, i) => {
    const month = fromDateKey(row.month);
    const label = formatMonthShort(month, i === 0 || month.getMonth() === 0);
    const cells = row.days.map(shade).join("") + " ".repeat(31 - row.days.length);
    const time = row.playedMs > 0 ? formatDuration(row.playedMs) : dim("–");
    lines.push(
      `  ${padEnd(label, STRIP_LABEL_WIDTH)} ${cells}  ${padStart(time, 8)}  ${dim(padStart(daysLabel(row.activeDays), 7))}`
    );
  });
  lines.push(
    "",
    `  ${dim("·")} none   ${green("░")} under 15m   ${green("▒")} under 30m   ${green("▓")} under 1h   ${green("█")} 1h or more`
  );
  return lines;
}

function streakText(streak: Streak): string {
  if (streak.days === 0 || !streak.from || !streak.to) return dim("none yet");
  return `${daysLabel(streak.days)} ${dim(`(${formatDateRange(streak.from, streak.to)})`)}`;
}

function parseYear(input: string): number {
  if (!/^\d{4}$/.test(input)) throw new Error(`Invalid year "${input}". Use YYYY, e.g. 2026.`);
  return Number(input);
}

function parseMonth(input: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(input);
  const month = match ? Number(match[2]) - 1 : -1;
  if (!match || month < 0 || month > 11) {
    throw new Error(`Invalid month "${input}". Use YYYY-MM, e.g. 2026-09.`);
  }
  return { year: Number(match[1]), month };
}

function cmdYear(yearArg: string | undefined, json: boolean) {
  const today = startOfDay(new Date());
  const year = yearArg ? parseYear(yearArg) : null;
  const firstMonth = year !== null ? new Date(year, 0, 1) : new Date(today.getFullYear(), today.getMonth() - 11, 1);
  const lastMonth =
    year !== null && year < today.getFullYear()
      ? new Date(year, 11, 1)
      : new Date(today.getFullYear(), today.getMonth(), 1);

  const store = openStore();
  const firstAt = store.firstListenAt();
  const listens = store.listensBetween(0, addDays(today, 1).getTime());
  store.close();

  if (firstAt === null) {
    console.log(dim("Nothing recorded yet. Play something in YouTube Music."));
    return;
  }

  const recordedFrom = startOfDay(new Date(firstAt));
  const totals = dailyTotals(listens);
  const rows = firstMonth > today ? [] : monthRows(totals, firstMonth, lastMonth, recordedFrom, today);
  const title = year !== null ? String(year) : "Last 12 months";
  const range = `${formatMonthShort(firstMonth, true)} – ${formatMonthShort(lastMonth, true)}`;

  if (rows.length === 0) {
    console.log(
      dim(`Nothing recorded in ${title.toLowerCase()}. Recording started ${formatDay(recordedFrom)} ${recordedFrom.getFullYear()}.`)
    );
    return;
  }

  const rangeStart = new Date(Math.max(firstMonth.getTime(), recordedFrom.getTime()));
  const rangeEnd = new Date(Math.min(addDays(new Date(lastMonth.getFullYear(), lastMonth.getMonth() + 1, 1), -1).getTime(), today.getTime()));
  const inRange = [...totals.values()].filter((day) => {
    const date = fromDateKey(day.date);
    return date >= rangeStart && date <= rangeEnd;
  });
  const activeDays = inRange.filter((day) => day.listens > 0).length;
  const playedMs = inRange.reduce((sum, day) => sum + day.playedMs, 0);
  const busiest = [...inRange].sort((a, b) => b.playedMs - a.playedMs)[0];
  const current = currentStreak(totals, today);
  const longest = longestStreak(totals, rangeStart, rangeEnd);

  if (json) {
    console.log(
      JSON.stringify(
        {
          from: toDateKey(rangeStart),
          to: toDateKey(rangeEnd),
          activeDays,
          playedMs,
          busiestDay: busiest ?? null,
          streak: { current, longest },
          months: rows,
        },
        null,
        2
      )
    );
    return;
  }

  const stats = [
    `${bold(String(activeDays))} ${activeDays === 1 ? "day" : "days"} with music`,
    `${bold(formatDuration(playedMs))} listened`,
    busiest && busiest.playedMs > 0 &&
      `busiest day ${formatDay(fromDateKey(busiest.date))} ${dim(`(${formatDuration(busiest.playedMs)})`)}`,
  ].filter(Boolean);

  printLines([
    "",
    `  ${bold(title)} ${dim(`· ${range}`)}`,
    "",
    ...renderStrips(rows),
    "",
    `  ${stats.join(dim("  ·  "))}`,
    `  ${padEnd("Streak", 10)}current ${current.days > 0 ? daysLabel(current.days) : dim("none")}${dim("  ·  ")}longest ${streakText(longest)}`,
    recordedFrom > firstMonth && dim(`  Recording started ${formatDay(recordedFrom)} ${recordedFrom.getFullYear()}.`),
    "",
    recorderHint(),
  ]);
}

function cmdWrapped(monthArg: string | undefined, yearArg: string | undefined, json: boolean) {
  if (monthArg && yearArg) throw new Error("Use either --month or --year, not both.");
  const today = startOfDay(new Date());
  const period = yearArg
    ? yearPeriod(parseYear(yearArg))
    : monthArg
      ? (({ year, month }) => monthPeriod(year, month))(parseMonth(monthArg))
      : monthPeriod(today.getFullYear(), today.getMonth());
  if (period.start > today) throw new Error("That period hasn't started yet.");

  const previous = previousPeriod(period);
  const store = openStore();
  const firstAt = store.firstListenAt();
  const listens = store.listensBetween(period.start.getTime(), period.end.getTime());
  const previousListens = store.listensBetween(previous.start.getTime(), previous.end.getTime());
  const priorTracks = new Set(store.listensBetween(0, period.start.getTime()).map(trackKey));
  store.close();

  const isMonth = period.kind === "month";
  const name = isMonth ? formatMonthLong(period.start, true) : String(period.start.getFullYear());

  if (firstAt === null || listens.length === 0) {
    const started = firstAt === null ? null : startOfDay(new Date(firstAt));
    console.log(
      dim(
        `Nothing recorded in ${name}.` +
          (started ? ` Recording started ${formatDay(started)} ${started.getFullYear()}.` : "")
      )
    );
    return;
  }

  const recordedFrom = startOfDay(new Date(firstAt));
  const recap = wrapped({ period, listens, previousListens, priorTracks, recordedFrom, today });

  if (json) {
    console.log(JSON.stringify(recap, null, 2));
    return;
  }

  const { summary } = recap;
  const title = recap.partial
    ? `${isMonth ? formatMonthLong(period.start, period.start.getFullYear() !== today.getFullYear()) : name} so far`
    : `Your ${name}`;
  const previousName = isMonth
    ? formatMonthLong(previous.start, previous.start.getFullYear() !== period.start.getFullYear())
    : String(previous.start.getFullYear());

  const change = recap.changeVsPrevious;
  const changeText =
    change === null
      ? null
      : Math.abs(change) < 0.005
        ? `about the same per day as ${previousName}`
        : `${Math.round(Math.abs(change) * 100)}% ${change > 0 ? "more" : "less"} per day than ${previousName}`;

  const headline = [
    `${bold(formatDuration(summary.playedMs))} listened`,
    `${summary.listens} ${summary.listens === 1 ? "listen" : "listens"}`,
    `${summary.uniqueTracks} ${summary.uniqueTracks === 1 ? "song" : "songs"}`,
    `${summary.artists.length} ${summary.artists.length === 1 ? "artist" : "artists"}`,
  ];
  const days = [
    `Music on ${recap.activeDays} of ${daysLabel(recap.recordedDays)}` +
      (recap.activeDays > 0 ? `, about ${formatDuration(recap.perActiveDayMs)} on those days` : ""),
    changeText,
  ].filter(Boolean);

  const topSongs = summary.tracks.slice(0, 5).map((track, i) => [
    String(i + 1),
    track.title,
    track.artist,
    String(track.plays),
    formatDuration(track.playedMs),
  ]);
  const topArtists = summary.artists.slice(0, 5).map((artist, i) => [
    String(i + 1),
    artist.artist,
    String(artist.tracks),
    String(artist.plays),
    formatDuration(artist.playedMs),
  ]);

  const maxBlock = Math.max(0, ...recap.hours.map((block) => block.playedMs));
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const hourRows = recap.hours.map(
    (block) =>
      `  ${pad2(block.hour)}–${pad2(block.hour + 3)}  ${bar(block.playedMs, maxBlock, 20)}  ${padStart(`${Math.round(block.share * 100)}%`, 4)}`
  );
  const peak = [...recap.hours].sort((a, b) => b.playedMs - a.playedMs)[0];

  const highlights: [string, string | null][] = [
    [
      "On repeat",
      recap.onRepeat &&
        `${recap.onRepeat.title}, ${recap.onRepeat.plays} plays on ${formatDay(fromDateKey(recap.onRepeat.date))}`,
    ],
    [
      "Biggest day",
      recap.biggestDay &&
        `${formatDay(fromDateKey(recap.biggestDay.date))}, ${formatDuration(recap.biggestDay.playedMs)}`,
    ],
    [
      "Peak hours",
      peak
        ? `${pad2(peak.hour)}:00 – ${pad2(peak.hour + 3)}:00 ${dim(`(${Math.round(peak.share * 100)}% of your listening)`)}`
        : null,
    ],
    [
      "Discoveries",
      recap.discoveries !== null && recap.discoveries > 0
        ? `${recap.discoveries} ${recap.discoveries === 1 ? "song" : "songs"} you'd never played before`
        : null,
    ],
    [
      "Most skipped",
      recap.mostSkipped && `${recap.mostSkipped.title}, skipped ${recap.mostSkipped.skips} times`,
    ],
    ["Longest streak", recap.longestStreak.days >= 2 ? streakText(recap.longestStreak) : null],
  ];

  const yearRows =
    period.kind === "year"
      ? monthRows(
          dailyTotals(listens),
          period.start,
          new Date(Math.min(new Date(period.start.getFullYear(), 11, 1).getTime(), today.getTime())),
          recordedFrom,
          today
        )
      : [];

  printLines([
    "",
    `  ${bold(title)}`,
    "",
    `  ${headline.join(dim("  ·  "))}`,
    `  ${days.join(dim("  ·  "))}`,
    recap.startedMidPeriod &&
      dim(`  Recording started ${formatDay(recordedFrom)} ${recordedFrom.getFullYear()}, so earlier days aren't included.`),
    ...(topSongs.length > 0
      ? [
          "",
          `  ${bold("Top songs")}`,
          table(
            [
              { header: "#", align: "right", style: dim },
              { header: "Track", flex: true },
              { header: "Artist", style: dim },
              { header: "Plays", align: "right", style: cyan },
              { header: "Time", align: "right", style: dim },
            ],
            topSongs
          ),
          "",
          `  ${bold("Top artists")}`,
          table(
            [
              { header: "#", align: "right", style: dim },
              { header: "Artist", flex: true },
              { header: "Songs", align: "right", style: dim },
              { header: "Plays", align: "right", style: cyan },
              { header: "Time", align: "right", style: dim },
            ],
            topArtists
          ),
        ]
      : []),
    ...(hourRows.length > 0 ? ["", `  ${bold("When you listen")}`, ...hourRows] : []),
    "",
    `  ${bold("Highlights")}`,
    ...highlights
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([label, value]) => `  ${padEnd(label, 16)}${value}`),
    ...(yearRows.length > 0 ? ["", `  ${bold("Month by month")}`, ...renderStrips(yearRows)] : []),
    "",
    recorderHint(),
  ]);
}

async function cmdNow(json: boolean) {
  const bin = findMediaControl();
  if (!bin) throw new Error("media-control not found. Install it with `brew install media-control`.");
  const snapshot = await getNowPlaying(bin);

  if (json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  if (!snapshot) {
    console.log(dim("Nothing is playing."));
    return;
  }

  const tracked = sourceBundleIds().includes(snapshot.bundleIdentifier);
  const icon = snapshot.playing ? green("▶") : yellow("❚❚");
  const position =
    snapshot.elapsedSec !== null && snapshot.durationSec
      ? `${formatPosition(snapshot.elapsedSec)} / ${formatPosition(snapshot.durationSec)}`
      : null;
  const details = [snapshot.album, position].filter(Boolean).join(" · ");

  printLines([
    `${icon} ${bold(snapshot.title)}${snapshot.artist ? ` — ${snapshot.artist}` : ""}`,
    details && `  ${dim(details)}`,
    !tracked && yellow(`  Playing in ${snapshot.bundleIdentifier}, which mixtape doesn't track.`),
  ]);
}

function cmdStatus() {
  const pid = runningDaemonPid();
  const store = openStore();
  const heartbeat = Number(store.getMeta("heartbeat_at") ?? 0);
  const daemonLog = store.getMeta("log_path") ?? logPath();
  const latest = store.latestListen();
  const total = store.countListens();
  store.close();

  const mediaControl = findMediaControl();
  const sources = sourceBundleIds();
  const managedBy = isLoaded(BREW_SERVICE_LABEL)
    ? "Homebrew service"
    : isLoaded(SERVICE_LABEL)
      ? "LaunchAgent"
      : "started by hand";

  const recorder =
    pid !== null
      ? `${green("running")} ${dim(`(pid ${pid}, ${managedBy})`)}`
      : `${red("not running")} ${dim("— run: mixtape service install")}`;

  const rows: [string, string][] = [
    ["Recorder", recorder],
    [
      "Last check-in",
      heartbeat > 0 ? `${formatDuration(Date.now() - heartbeat)} ago` : dim("never"),
    ],
    ["media-control", mediaControl ?? red("not found — brew install media-control")],
    [
      "Tracking",
      sources
        .map((id) => (id === YT_MUSIC_PWA_BUNDLE_ID ? `YouTube Music app ${dim(`(${id})`)}` : id))
        .join(", "),
    ],
    ["Database", `${tildify(dbPath())} ${dim(`(${total} plays)`)}`],
    ["Log", tildify(daemonLog)],
    [
      "Last play",
      latest
        ? `${truncate(trackLabel(latest.title, latest.artist), 50)} ${dim(
            `· ${toDateKey(new Date(latest.startedAt))} ${formatClock(latest.startedAt)}`
          )}`
        : dim("none yet"),
    ],
  ];

  printLines([
    `${bold("mixtape")} ${dim(version())}`,
    ...rows.map(([label, value]) => `  ${padEnd(label, 14)}${value}`),
  ]);
}

async function cmdService(action: string | undefined) {
  if (action === "install") {
    if (isLoaded(BREW_SERVICE_LABEL)) {
      console.log(yellow("The Homebrew service is already running the recorder; nothing to do."));
      return;
    }
    const file = await installService();
    console.log(`${green("✓")} Recorder installed as a LaunchAgent and started.`);
    console.log(dim(`  ${tildify(file)}`));
    return;
  }
  if (action === "uninstall") {
    const removed = await uninstallService();
    console.log(removed ? `${green("✓")} Recorder LaunchAgent removed.` : "No LaunchAgent was installed.");
    return;
  }
  if (action === "status" || action === undefined) {
    console.log(
      isLoaded(SERVICE_LABEL)
        ? `LaunchAgent loaded ${dim(`(${tildify(plistPath())})`)}`
        : isLoaded(BREW_SERVICE_LABEL)
          ? "Running as a Homebrew service."
          : "No background service is loaded."
    );
    return;
  }
  throw new Error(`Unknown service action "${action}". Use install, uninstall or status.`);
}

export async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      date: { type: "string", short: "d" },
      month: { type: "string" },
      year: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.help) return void console.log(HELP);
  if (values.version) return void console.log(version());

  const [command = "today", ...rest] = positionals;
  const json = values.json ?? false;

  switch (command) {
    case "today":
      return cmdToday(parseDay(values.date), json);
    case "week":
      return cmdWeek(parseDay(values.date), json);
    case "log":
      return cmdLog(parseDay(values.date), json);
    case "year":
    case "heatmap":
      return cmdYear(values.year, json);
    case "wrapped":
      return cmdWrapped(values.month, values.year, json);
    case "now":
      return cmdNow(json);
    case "status":
      return cmdStatus();
    case "daemon":
      return runDaemon();
    case "service":
      return cmdService(rest[0]);
    case "help":
      return void console.log(HELP);
    default:
      throw new Error(`Unknown command "${command}". Run \`mixtape --help\`.`);
  }
}
