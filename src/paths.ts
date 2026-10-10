import { homedir } from "node:os";
import { join } from "node:path";

// MIXTAPE_HOME wins, then XDG_DATA_HOME, then ~/.local/share.
export function dataDir(): string {
  if (process.env.MIXTAPE_HOME) return process.env.MIXTAPE_HOME;
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdg, "mixtape");
}

export function dbPath(): string {
  return join(dataDir(), "mixtape.db");
}

export function pidPath(): string {
  return join(dataDir(), "daemon.pid");
}

export function logPath(): string {
  return join(dataDir(), "daemon.log");
}
