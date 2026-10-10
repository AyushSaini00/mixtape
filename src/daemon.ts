import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { findMediaControl, sourceBundleIds, streamNowPlaying, type StreamHandle } from "./media.ts";
import { dataDir, dbPath, logPath, pidPath } from "./paths.ts";
import { Recorder, TICK_MS } from "./recorder.ts";
import { Store } from "./store.ts";

const LOCK_RETRY_MS = 30_000;
const MAX_RESTART_DELAY_MS = 60_000;

function log(message: string) {
  console.log(`${new Date().toISOString()} ${message}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function runningDaemonPid(): number | null {
  try {
    const pid = Number(readFileSync(pidPath(), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

// Only one recorder may run. If another one holds the lock (say, both a
// Homebrew service and a manual LaunchAgent are loaded), wait quietly instead
// of exiting, so launchd doesn't restart us in a tight loop.
async function acquireLock() {
  mkdirSync(dataDir(), { recursive: true });
  let warned = false;
  for (;;) {
    const other = runningDaemonPid();
    if (other === null) break;
    if (!warned) {
      log(`another mixtape daemon is running (pid ${other}); waiting for it to exit`);
      warned = true;
    }
    await sleep(LOCK_RETRY_MS);
  }
  writeFileSync(pidPath(), `${process.pid}\n`);
}

function releaseLock() {
  try {
    if (readFileSync(pidPath(), "utf8").trim() === String(process.pid)) rmSync(pidPath());
  } catch {
    // already gone
  }
}

export async function runDaemon() {
  await acquireLock();

  const store = new Store(dbPath());
  const closed = store.closeDangling();
  const sources = sourceBundleIds();
  const recorder = new Recorder(store, sources);

  // Wherever launchd sends our output, so `mixtape status` can point at it.
  store.setMeta("log_path", process.env.MIXTAPE_LOG_FILE ?? logPath());
  store.setMeta("heartbeat_at", String(Date.now()));

  log(`mixtape daemon started (pid ${process.pid})`);
  log(`database: ${dbPath()}`);
  log(`tracking: ${sources.join(", ")}`);
  if (closed > 0) log(`closed ${closed} listen(s) left open by a previous run`);

  let stream: StreamHandle | null = null;
  let stopping = false;
  let restartDelay = 1_000;

  const connect = () => {
    if (stopping) return;
    const bin = findMediaControl();
    if (!bin) {
      log("media-control not found; install it with `brew install media-control`. Retrying in 60s.");
      setTimeout(connect, MAX_RESTART_DELAY_MS);
      return;
    }

    stream = streamNowPlaying(
      bin,
      (snapshot) => {
        restartDelay = 1_000;
        recorder.handle(snapshot, Date.now());
      },
      (code, stderr) => {
        stream = null;
        if (stopping) return;
        // Whatever was playing is unknown until the stream is back.
        recorder.handle(null, Date.now());
        log(`media-control exited (code ${code})${stderr ? `: ${stderr}` : ""}; restarting in ${restartDelay / 1000}s`);
        setTimeout(connect, restartDelay);
        restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY_MS);
      }
    );
  };

  connect();

  const ticker = setInterval(() => {
    const now = Date.now();
    recorder.tick(now);
    store.setMeta("heartbeat_at", String(now));
  }, TICK_MS);

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`received ${signal}, shutting down`);
    clearInterval(ticker);
    stream?.stop();
    recorder.stop(Date.now());
    store.close();
    releaseLock();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
}
