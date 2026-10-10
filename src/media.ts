/*
Reads macOS "Now Playing" through the `media-control` CLI
(https://github.com/ungive/media-control). Since macOS 15.4 ordinary processes
can't query MediaRemote directly; media-control works around that, so we
shell out to it instead of linking anything ourselves.
*/

import { execFile, execFileSync, spawn } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

export type Snapshot = {
  bundleIdentifier: string;
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  elapsedSec: number | null;
  durationSec: number | null;
};

// Chrome derives installed-web-app IDs from the app's manifest, so the
// YouTube Music PWA gets this ID on every Mac.
export const YT_MUSIC_PWA_BUNDLE_ID =
  "com.google.Chrome.app.cinhimbnkkaeohfgghhklpknlkffjgod";

const FALLBACK_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Turns a media-control payload into a Snapshot, or null when nothing
// identifiable is playing (media-control emits empty payloads between tracks).
export function parsePayload(payload: unknown): Snapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  const bundleIdentifier = str(p.bundleIdentifier);
  const title = str(p.title);
  if (!bundleIdentifier || !title) return null;

  return {
    bundleIdentifier,
    title,
    artist: str(p.artist),
    album: str(p.album),
    playing: p.playing === true,
    elapsedSec: num(p.elapsedTimeNow) ?? num(p.elapsedTime),
    durationSec: num(p.duration),
  };
}

export function findMediaControl(): string | null {
  const override = process.env.MIXTAPE_MEDIA_CONTROL;
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...FALLBACK_BIN_DIRS];
  const candidates = override ? [override] : dirs.filter(Boolean).map((dir) => join(dir, "media-control"));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

// Bundle IDs of every installed Chromium web app that opens music.youtube.com,
// e.g. ~/Applications/Chrome Apps.localized/YouTube Music.app.
function discoverPwaBundleIds(): string[] {
  const appsRoot = join(homedir(), "Applications");
  const ids: string[] = [];

  let folders: string[];
  try {
    folders = readdirSync(appsRoot).filter((name) => name.endsWith(" Apps.localized"));
  } catch {
    return ids;
  }

  for (const folder of folders) {
    let apps: string[];
    try {
      apps = readdirSync(join(appsRoot, folder)).filter((name) => name.endsWith(".app"));
    } catch {
      continue;
    }

    for (const app of apps) {
      try {
        const json = execFileSync(
          "/usr/bin/plutil",
          ["-convert", "json", "-o", "-", join(appsRoot, folder, app, "Contents", "Info.plist")],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        );
        const info = JSON.parse(json) as Record<string, unknown>;
        const url = str(info.CrAppModeShortcutURL);
        const id = str(info.CFBundleIdentifier);
        if (id && new URL(url).hostname === "music.youtube.com") ids.push(id);
      } catch {
        // not a web app shim, or unreadable
      }
    }
  }
  return ids;
}

// Which "Now Playing" apps count as YouTube Music. MIXTAPE_SOURCES
// (comma-separated bundle IDs) replaces the defaults entirely.
export function sourceBundleIds(): string[] {
  const override = process.env.MIXTAPE_SOURCES;
  if (override) {
    return override.split(",").map((id) => id.trim()).filter(Boolean);
  }
  return [...new Set([YT_MUSIC_PWA_BUNDLE_ID, ...discoverPwaBundleIds()])];
}

export function getNowPlaying(bin: string): Promise<Snapshot | null> {
  return new Promise((resolve, reject) => {
    execFile(bin, ["get"], { encoding: "utf8", timeout: 10_000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(parsePayload(JSON.parse(stdout)));
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
}

export type StreamHandle = { stop(): void };

// Spawns `media-control stream` and reports each full snapshot. Calls onExit
// when the child goes away so the caller can decide whether to restart.
export function streamNowPlaying(
  bin: string,
  onSnapshot: (snapshot: Snapshot | null) => void,
  onExit: (code: number | null, stderr: string) => void
): StreamHandle {
  const child = spawn(bin, ["stream", "--no-diff"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-2_000);
  });

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line) as { type?: string; payload?: unknown };
      if (message.type !== "data") return;
      onSnapshot(parsePayload(message.payload));
    } catch {
      // ignore partial or non-JSON lines
    }
  });

  let exited = false;
  const exit = (code: number | null) => {
    if (exited) return;
    exited = true;
    onExit(code, stderr.trim());
  };
  child.on("error", (err) => {
    stderr += String(err);
    exit(null);
  });
  child.on("close", (code) => exit(code));

  return {
    stop() {
      child.kill();
    },
  };
}
