import assert from "node:assert/strict";
import test from "node:test";

import { DEGREES_PER_CARD, settlePose, showsBack } from "../app/flip-math.ts";

const norm = (deg) => ((deg % 360) + 360) % 360;

/** The contract: settling never leaves the card twisted in its own plane. */
function assertUpright(pose) {
  assert.equal(norm(pose.x), 0, `x should land on a multiple of 360, got ${pose.x}`);
}

/** ...and never changes which face you were looking at. */
function assertKeepsFace(x, y) {
  const pose = settlePose(x, y);
  assertUpright(pose);
  assert.equal(
    showsBack(pose.x, pose.y),
    showsBack(x, y),
    `settling (${x}, ${y}) flipped the visible face`,
  );
}

test("showsBack: front at rest, back after half a turn on either axis", () => {
  assert.equal(showsBack(0, 0), false);
  assert.equal(showsBack(0, 180), true);
  assert.equal(showsBack(180, 0), true);
  // Half a turn on both axes cancels out — front again.
  assert.equal(showsBack(180, 180), false);
  assert.equal(showsBack(0, 360), false);
  assert.equal(showsBack(0, -180), true);
});

test("settlePose: a small nudge springs back to the face it started on", () => {
  assert.deepEqual(settlePose(10, 20), { x: 0, y: 0 });
  assert.deepEqual(settlePose(-8, -15), { x: 0, y: 0 });
});

test("settlePose: past the halfway point it commits to the other face", () => {
  assert.deepEqual(settlePose(0, 100), { x: 0, y: 180 });
  assert.deepEqual(settlePose(0, -100), { x: 0, y: -180 });
});

test("settlePose: a vertical flip lands on an upright back, not an upside-down one", () => {
  // Dragging up past 90° shows the back; X must unwind to 0 and Y carry the turn,
  // otherwise the back renders upside down and cannot be read.
  const pose = settlePose(110, 0);
  assert.equal(showsBack(110, 0), true);
  assertUpright(pose);
  assert.equal(norm(pose.y), 180);
  assert.equal(showsBack(pose.x, pose.y), true);
});

test("settlePose: downward vertical flip behaves the same", () => {
  const pose = settlePose(-110, 0);
  assertUpright(pose);
  assert.equal(norm(pose.y), 180);
  assert.equal(showsBack(pose.x, pose.y), true);
});

test("settlePose: accumulated multi-turn rotations still settle upright", () => {
  for (const [x, y] of [
    [720, 1800],
    [-360, 900],
    [1080, -540],
    [360, 1825.7],
  ]) {
    assertUpright(settlePose(x, y));
    assert.equal(norm(settlePose(x, y).y) % 180, 0);
  }
});

test("settlePose preserves the visible face across a sweep of poses", () => {
  for (let x = -400; x <= 400; x += 17) {
    for (let y = -400; y <= 400; y += 23) {
      // Skip poses sitting exactly on the edge, where the face is ambiguous.
      if (Math.abs(Math.cos((x * Math.PI) / 180) * Math.cos((y * Math.PI) / 180)) < 1e-9) continue;
      assertKeepsFace(x, y);
    }
  }
});

test("settlePose is idempotent — a settled pose settles to itself", () => {
  for (const [x, y] of [[0, 0], [0, 180], [360, 540], [-360, -180]]) {
    assert.deepEqual(settlePose(x, y), settlePose(...Object.values(settlePose(x, y))));
  }
});

test("a full card-width drag is exactly half a turn", () => {
  assert.equal(DEGREES_PER_CARD, 180);
});
