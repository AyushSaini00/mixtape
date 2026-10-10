import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import type { Snapshot } from "../src/media.ts";
import { Recorder } from "../src/recorder.ts";
import { Store } from "../src/store.ts";

const APP = "com.google.Chrome.app.cinhimbnkkaeohfgghhklpknlkffjgod";
const T0 = new Date(2026, 9, 10, 10, 0, 0).getTime();
const sec = (n: number) => T0 + n * 1000;

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    bundleIdentifier: APP,
    title: "Feel It Still",
    artist: "Portugal. The Man",
    album: "",
    playing: true,
    elapsedSec: 0,
    durationSec: 163,
    ...overrides,
  };
}

let store: Store;
let recorder: Recorder;

function all() {
  return store.listensBetween(0, Number.MAX_SAFE_INTEGER);
}

// Drive ticks every 5s between two points, like the daemon's interval does.
function tickThrough(fromSec: number, toSec: number) {
  for (let t = fromSec + 5; t <= toSec; t += 5) recorder.tick(sec(t));
}

beforeEach(() => {
  store = new Store(":memory:");
  recorder = new Recorder(store, [APP]);
});

describe("Recorder", () => {
  test("records a track and accrues played time", () => {
    recorder.handle(snap(), sec(0));
    tickThrough(0, 60);
    recorder.stop(sec(60));

    const [listen, ...rest] = all();
    assert.equal(rest.length, 0);
    assert.equal(listen?.title, "Feel It Still");
    assert.equal(listen?.artist, "Portugal. The Man");
    assert.equal(listen?.durationMs, 163_000);
    assert.equal(listen?.playedMs, 60_000);
    assert.equal(listen?.endedAt, sec(60));
    assert.equal(listen?.open, false);
  });

  test("paused time doesn't count", () => {
    recorder.handle(snap(), sec(0));
    tickThrough(0, 20);
    recorder.handle(snap({ playing: false, elapsedSec: 20 }), sec(20));
    tickThrough(20, 120);
    recorder.handle(snap({ playing: true, elapsedSec: 20 }), sec(120));
    tickThrough(120, 150);
    recorder.stop(sec(150));

    assert.equal(all()[0]?.playedMs, 50_000);
  });

  test("a skip closes the previous track and starts the next", () => {
    recorder.handle(snap({ title: "Wish You Were Here", artist: "Pink Floyd" }), sec(0));
    tickThrough(0, 10);
    recorder.handle(null, sec(11));
    recorder.handle(snap(), sec(12));
    tickThrough(12, 30);
    recorder.stop(sec(30));

    const [first, second] = all();
    assert.equal(first?.title, "Wish You Were Here");
    assert.equal(first?.playedMs, 11_000);
    assert.equal(first?.open, false);
    assert.equal(second?.title, "Feel It Still");
    assert.equal(second?.playedMs, 18_000);
  });

  test("artist and album that arrive late are filled into the same listen", () => {
    const title = "Wish You Were Here";
    recorder.handle(snap({ title, artist: "", album: "", elapsedSec: null, durationSec: null }), sec(0));
    recorder.handle(snap({ title, artist: "Pink Floyd", album: "", durationSec: 335 }), sec(1));
    recorder.handle(snap({ title, artist: "Pink Floyd", album: "Wish You Were Here", elapsedSec: 3, durationSec: 334.74 }), sec(3));
    recorder.stop(sec(10));

    const rows = all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.artist, "Pink Floyd");
    assert.equal(rows[0]?.album, "Wish You Were Here");
    assert.equal(rows[0]?.durationMs, 334_740);
  });

  test("looping the same track counts each play separately", () => {
    recorder.handle(snap({ elapsedSec: 0 }), sec(0));
    tickThrough(0, 160);
    recorder.handle(snap({ elapsedSec: 0.2 }), sec(163));
    tickThrough(163, 200);
    recorder.stop(sec(200));

    const rows = all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.playedMs, 163_000);
    assert.equal(rows[1]?.startedAt, sec(163));
  });

  test("a replay is still detected when a blank snapshot comes first", () => {
    recorder.handle(snap({ elapsedSec: 0 }), sec(0));
    tickThrough(0, 160);
    recorder.handle(null, sec(163));
    recorder.handle(snap({ elapsedSec: 0 }), sec(164));
    recorder.stop(sec(175));

    assert.equal(all().length, 2);
  });

  test("seeking a little within the track isn't a replay", () => {
    recorder.handle(snap({ elapsedSec: 0 }), sec(0));
    recorder.handle(snap({ elapsedSec: 2 }), sec(5));
    recorder.stop(sec(10));

    assert.equal(all().length, 1);
  });

  test("a paused track in the player isn't recorded until it plays", () => {
    recorder.handle(snap({ playing: false, elapsedSec: 40 }), sec(0));
    assert.equal(all().length, 0);

    recorder.handle(snap({ playing: true, elapsedSec: 40 }), sec(30));
    recorder.stop(sec(40));
    assert.equal(all()[0]?.startedAt, sec(30));
    assert.equal(all()[0]?.playedMs, 10_000);
  });

  test("other apps are ignored and pause the current listen", () => {
    recorder.handle(snap(), sec(0));
    tickThrough(0, 10);
    recorder.handle(snap({ bundleIdentifier: "com.spotify.client", title: "Other" }), sec(10));
    tickThrough(10, 60);
    recorder.stop(sec(60));

    const rows = all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.playedMs, 10_000);
  });

  test("time while the Mac slept isn't counted", () => {
    recorder.handle(snap(), sec(0));
    tickThrough(0, 30);
    // No ticks for an hour: the process was suspended.
    recorder.tick(sec(3630));
    tickThrough(3630, 3640);
    recorder.stop(sec(3640));

    assert.equal(all()[0]?.playedMs, 40_000);
  });

  test("a track paused for over 30 minutes is closed", () => {
    recorder.handle(snap(), sec(0));
    recorder.handle(snap({ playing: false, elapsedSec: 10 }), sec(10));
    recorder.tick(sec(10 + 30 * 60));

    assert.equal(all()[0]?.open, false);
    assert.equal(all()[0]?.endedAt, sec(10));
    assert.equal(recorder.current(), null);
  });

  test("progress is flushed while playing, so a crash loses at most a tick", () => {
    recorder.handle(snap(), sec(0));
    tickThrough(0, 45);

    const [listen] = all();
    assert.equal(listen?.open, true);
    assert.equal(listen?.playedMs, 45_000);
  });
});

// Event timings from a real media-control session (with the README's songs as
// tracks): a pause and resume, three skips, and a pause on the third track
// right before the last skip. Offsets are seconds after the stream started.
describe("Recorder on a real media-control session", () => {
  const WISH = { title: "Wish You Were Here", artist: "Pink Floyd", album: "Wish You Were Here", durationSec: 334.74 };
  const SPEED = { title: "Speed of Sound", artist: "Coldplay", album: "", durationSec: 288.13 };
  const FEEL = { title: "Feel It Still", artist: "Portugal. The Man", album: "", durationSec: 163.2 };

  const events: [number, Snapshot | null][] = [
    [0, null],
    [0, snap({ ...WISH, playing: true, elapsedSec: 23.53 })],
    [1, snap({ ...WISH, playing: false, elapsedSec: 23.53 })],
    [1, snap({ ...WISH, playing: false, elapsedSec: 56.99 })],
    [4, snap({ ...WISH, playing: false, elapsedSec: 56.99 })],
    [4, snap({ ...WISH, playing: true, elapsedSec: 56.99 })],
    [5, snap({ ...WISH, playing: true, elapsedSec: 56.99 })],
    [6, null],
    [6, snap({ ...SPEED, playing: true, elapsedSec: 0.1 })],
    [6, snap({ ...SPEED, playing: true, elapsedSec: 0.1 })],
    [9, snap({ ...SPEED, playing: true, elapsedSec: 3.13 })],
    [17, null],
    [17, snap({ ...FEEL, artist: "", playing: true, elapsedSec: null, durationSec: null })],
    [18, snap({ ...FEEL, playing: true, elapsedSec: 0, durationSec: 164 })],
    [18, snap({ ...FEEL, playing: true, elapsedSec: 0, durationSec: 164 })],
    [21, snap({ ...FEEL, playing: true, elapsedSec: 3.09 })],
    [21, snap({ ...FEEL, playing: false, elapsedSec: 3.09 })],
    [23, snap({ ...FEEL, playing: false, elapsedSec: 5.81 })],
    [28, null],
    [28, snap({ ...WISH, playing: true, elapsedSec: 0.02 })],
    [28, snap({ ...WISH, playing: true, elapsedSec: 0.02 })],
    [31, snap({ ...WISH, playing: true, elapsedSec: 3.09 })],
  ];

  test("produces one listen per track with sensible play times", () => {
    for (const [offset, snapshot] of events) recorder.handle(snapshot, sec(offset));
    recorder.stop(sec(40));

    assert.deepEqual(
      all().map((l) => [l.title, l.artist, l.album, Math.round(l.playedMs / 1000)]),
      [
        ["Wish You Were Here", "Pink Floyd", "Wish You Were Here", 3],
        ["Speed of Sound", "Coldplay", "", 11],
        ["Feel It Still", "Portugal. The Man", "", 4],
        ["Wish You Were Here", "Pink Floyd", "Wish You Were Here", 12],
      ]
    );
  });
});
