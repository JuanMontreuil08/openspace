import assert from "node:assert/strict";
import test from "node:test";

import {
  getOrbitFreshness,
  ORBIT_STALE_AFTER_MS,
} from "./orbit-freshness.ts";

const NOW = Date.parse("2026-08-10T12:00:00Z");

test("describes recent orbital epochs in plain language", () => {
  assert.equal(
    getOrbitFreshness("2026-08-10T11:32:00Z", NOW).ageLabel,
    "28 minutes old",
  );
  assert.equal(
    getOrbitFreshness("2026-08-09T11:00:00Z", NOW).ageLabel,
    "25 hours old",
  );
  assert.equal(
    getOrbitFreshness("2026-08-07T12:00:00Z", NOW).ageLabel,
    "3 days old",
  );
});

test("marks an orbit stale only after the 3.5-day threshold", () => {
  const exactlyAtThreshold = new Date(NOW - ORBIT_STALE_AFTER_MS).toISOString();
  const justPastThreshold = new Date(NOW - ORBIT_STALE_AFTER_MS - 1).toISOString();
  assert.equal(getOrbitFreshness(exactlyAtThreshold, NOW).isStale, false);
  assert.equal(getOrbitFreshness(justPastThreshold, NOW).isStale, true);
});

test("handles invalid and future epochs safely", () => {
  assert.deepEqual(getOrbitFreshness("not-a-date", NOW), {
    epoch: null,
    ageLabel: null,
    isStale: false,
  });
  assert.equal(
    getOrbitFreshness("2026-08-10T12:05:00Z", NOW).ageLabel,
    "just updated",
  );
});
