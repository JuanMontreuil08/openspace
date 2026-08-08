import assert from "node:assert/strict";
import test from "node:test";
import {
  findGroundTrackSample,
  formatGroundTrackOffset,
} from "./ground-track.ts";

const samples = [
  { latitude: 1, longitude: 2, offsetMinutes: -20 },
  { latitude: 3, longitude: 4, offsetMinutes: -19.5 },
  { latitude: 5, longitude: 6, offsetMinutes: 0 },
  { latitude: 7, longitude: 8, offsetMinutes: 40 },
];

test("selects the nearest calculated 30-second ground-track sample", () => {
  assert.equal(findGroundTrackSample(samples, -19.6), samples[1]);
  assert.equal(findGroundTrackSample(samples, 39.9), samples[3]);
  assert.equal(findGroundTrackSample([], 0), null);
});

test("describes past, current, and predicted offsets in plain language", () => {
  assert.equal(formatGroundTrackOffset(-12), "12 min ago");
  assert.equal(formatGroundTrackOffset(0), "Now");
  assert.equal(formatGroundTrackOffset(18.5), "In 18.5 min");
});
