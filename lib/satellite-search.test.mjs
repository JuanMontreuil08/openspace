import assert from "node:assert/strict";
import test from "node:test";

import { searchSatelliteCatalog } from "./satellite-search.ts";

const catalog = [
  { noradId: 1, name: "Alpha", alternateName: null, operator: "Orbital Co", country: "US" },
  { noradId: 2, name: "Beta", alternateName: "Second", operator: null, country: "PE" },
];

test("empty search returns only the selected satellite", () => {
  const result = searchSatelliteCatalog(catalog, 1, "");
  assert.deepEqual(result.results.map(({ index }) => index), [1]);
  assert.equal(result.totalMatches, 1);
});

test("typed search covers identifiers and metadata", () => {
  assert.equal(searchSatelliteCatalog(catalog, 0, "second").results[0].index, 1);
  assert.equal(searchSatelliteCatalog(catalog, 0, "orbital").results[0].index, 0);
  assert.equal(searchSatelliteCatalog(catalog, 0, "2").results[0].index, 1);
});

test("typed results are capped without losing the total match count", () => {
  const many = Array.from({ length: 150 }, (_, index) => ({
    ...catalog[0],
    noradId: index + 1,
    name: `Satellite ${index}`,
  }));
  const result = searchSatelliteCatalog(many, 0, "satellite");
  assert.equal(result.results.length, 100);
  assert.equal(result.totalMatches, 150);
});
