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
import { countsAsListen, summarize, summarizeDays } from "./stats.ts";
import { Store } from "./store.ts";
import {
  addDays,
  formatClock,
  formatDay,
  formatDuration,
  formatPosition,
  parseDay,
  startOfDay,
  toDateKey,
} from "./time.ts";

const HELP = `${bold("mixtape")} — your YouTube Music listening habits, from the terminal

${bold("Usage")}
  mixtape [today]          Listens, listening time and songs played today
  mixtape week             The last 7 days: per-day totals, top tracks and artists
  mixtape log              Every play today, in order (including skips)
  mixtape now              What's playing right now
  mixtape status           Is the recorder running? Where is the data?

  mixtape daemon           Run the recorder in the foreground
  mixtape service install  Run the recorder in the background at login
  mixtape service uninstall

${bold("Options")}
  -d, --date <day>         YYYY-MM-DD, "today" or "yesterday" (for week: the last day)
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
  store.close();
  const summary = summarize(listens);

  if (json) {
    console.log(JSON.stringify({ date: toDateKey(day), ...summary }, null, 2));
    return;
  }

  const stats = [
    `${bold(String(summary.listens))} ${summary.listens === 1 ? "listen" : "listens"}`,
    `${bold(formatDuration(summary.playedMs))} listened`,
    summary.skipped > 0 && `${summary.skipped} skipped`,
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
