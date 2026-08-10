import assert from "node:assert/strict";
import test from "node:test";

import {
  celestrakSnapshotAgeMs,
  MAX_CELESTRAK_SNAPSHOT_AGE_MS,
  parseCelestrakSnapshot,
  serializeCelestrakSnapshot,
} from "./source-snapshot.ts";

const now = new Date("2026-08-10T12:00:00.000Z");

test("accepts a CelesTrak snapshot exactly 24 hours old", () => {
  assert.equal(
    celestrakSnapshotAgeMs("2026-08-09T12:00:00.000Z", now),
    MAX_CELESTRAK_SNAPSHOT_AGE_MS,
  );
});

test("stores the CelesTrak body and timestamp in one snapshot envelope", () => {
  const snapshot = {
    fetchedAt: "2026-08-10T12:00:00.000Z",
    body: '[{"NORAD_CAT_ID":1}]',
  };
  assert.deepEqual(parseCelestrakSnapshot(serializeCelestrakSnapshot(snapshot)), snapshot);
  assert.throws(() => parseCelestrakSnapshot('{"fetchedAt":"2026-08-10T12:00:00.000Z"}'));
});

test("rejects stale, future, and malformed snapshot timestamps", () => {
  assert.throws(() => celestrakSnapshotAgeMs("2026-08-09T11:59:59.999Z", now));
  assert.throws(() => celestrakSnapshotAgeMs("2026-08-10T12:00:00.001Z", now));
  assert.throws(() => celestrakSnapshotAgeMs("not-a-date", now));
});
