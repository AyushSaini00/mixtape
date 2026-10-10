import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Listen = {
  id: number;
  title: string;
  artist: string;
  album: string;
  durationMs: number | null;
  startedAt: number;
  // Last moment the track was audibly playing (or startedAt if it never was).
  endedAt: number;
  playedMs: number;
  source: string;
  // True while the daemon still considers this the current track.
  open: boolean;
};

export type NewListen = Pick<
  Listen,
  "title" | "artist" | "album" | "durationMs" | "startedAt" | "source"
>;

export type ListenUpdate = Partial<
  Pick<
    Listen,
    "title" | "artist" | "album" | "durationMs" | "endedAt" | "playedMs" | "open"
  >
>;

const SCHEMA_VERSION = 1;

const COLUMNS: Record<keyof ListenUpdate, string> = {
  title: "title",
  artist: "artist",
  album: "album",
  durationMs: "duration_ms",
  endedAt: "ended_at",
  playedMs: "played_ms",
  open: "open",
};

type Row = {
  id: number;
  title: string;
  artist: string;
  album: string;
  duration_ms: number | null;
  started_at: number;
  ended_at: number;
  played_ms: number;
  source: string;
  open: number;
};

function toListen(row: Row): Listen {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    playedMs: row.played_ms,
    source: row.source,
    open: row.open === 1,
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate() {
    const { user_version } = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (user_version >= SCHEMA_VERSION) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS listens (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        artist TEXT NOT NULL DEFAULT '',
        album TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        played_ms INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        open INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS listens_started_at ON listens (started_at);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  startListen(listen: NewListen): number {
    const result = this.db
      .prepare(
        `INSERT INTO listens (title, artist, album, duration_ms, started_at, ended_at, played_ms, source, open)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1)`
      )
      .run(
        listen.title,
        listen.artist,
        listen.album,
        listen.durationMs,
        listen.startedAt,
        listen.startedAt,
        listen.source
      );
    return Number(result.lastInsertRowid);
  }

  updateListen(id: number, update: ListenUpdate) {
    const keys = Object.keys(update) as (keyof ListenUpdate)[];
    if (keys.length === 0) return;

    const sets = keys.map((key) => `${COLUMNS[key]} = ?`).join(", ");
    const values = keys.map((key) => {
      const value = update[key];
      return typeof value === "boolean" ? Number(value) : (value ?? null);
    });
    this.db.prepare(`UPDATE listens SET ${sets} WHERE id = ?`).run(...values, id);
  }

  // A previous daemon may have died mid-track; its rows are already flushed up
  // to the last tick, so they only need to be marked closed.
  closeDangling(): number {
    const result = this.db.prepare("UPDATE listens SET open = 0 WHERE open = 1").run();
    return Number(result.changes);
  }

  listensBetween(from: number, to: number): Listen[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM listens WHERE started_at >= ? AND started_at < ? ORDER BY started_at"
      )
      .all(from, to) as Row[];
    return rows.map(toListen);
  }

  latestListen(): Listen | null {
    const row = this.db
      .prepare("SELECT * FROM listens ORDER BY started_at DESC LIMIT 1")
      .get() as Row | undefined;
    return row ? toListen(row) : null;
  }

  countListens(): number {
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM listens").get() as { n: number };
    return n;
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
      )
      .run(key, value);
  }

  close() {
    this.db.close();
  }
}
