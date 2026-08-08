import assert from "node:assert/strict";
import test from "node:test";
import { getMapStyle } from "./map-style.ts";

test("mapcn uses the CARTO vector styles from Crafter Tracker", () => {
  assert.equal(
    getMapStyle("dark"),
    "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  );
  assert.equal(
    getMapStyle("light"),
    "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  );
});
