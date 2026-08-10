import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSatelliteCatalog,
  MINIMUM_ACTIVE_CATALOG_SIZE,
  validateAuthoritativeCatalog,
} from "./satellite-catalog.ts";

function orbit(noradId) {
  return {
    OBJECT_NAME: `SAT-${noradId}`,
    OBJECT_ID: `2026-${String(noradId).padStart(3, "0")}A`,
    EPOCH: "2026-08-10T00:00:00.000000",
    MEAN_MOTION: 15,
    ECCENTRICITY: 0.001,
    INCLINATION: 51.6,
    RA_OF_ASC_NODE: 1,
    ARG_OF_PERICENTER: 2,
    MEAN_ANOMALY: 3,
    NORAD_CAT_ID: noradId,
    ELEMENT_SET_NO: 1,
    BSTAR: 0,
    MEAN_MOTION_DOT: 0,
    MEAN_MOTION_DDOT: 0,
  };
}

function catalog() {
  return Array.from({ length: MINIMUM_ACTIVE_CATALOG_SIZE }, (_, index) => orbit(index + 1));
}

function existing(noradId, overrides = {}) {
  return {
    norad_id: noradId,
    satnogs_id: null,
    alternate_name: null,
    operator: "AI Operator",
    operator_source: "ai",
    operator_description: "Evidence-backed operator description.",
    manufacturer: null,
    country: null,
    launch_date: null,
    mission_category: null,
    mission_description: "Evidence-backed mission description.",
    data_center_relation: null,
    source_urls: [{ label: "OpenAI mission research", url: "https://example.com/mission" }],
    mission_enriched_at: "2026-08-01T00:00:00.000Z",
    operator_enriched_at: "2026-08-01T00:00:00.000Z",
    gcat_verified_at: null,
    satnogs_verified_at: null,
    ...overrides,
  };
}

test("CelesTrak defines every synchronized row when optional sources are absent", () => {
  const celestrak = catalog();
  const result = buildSatelliteCatalog({ celestrak, syncedAt: "2026-08-10T12:00:00.000Z" });
  assert.equal(result.rows.length, celestrak.length);
  assert.equal(result.rows[0].satnogs_id, null);
  assert.equal(result.rows[0].name, "SAT-1");
});

test("direct catalog ownership overrides an AI operator and clears stale AI operator prose", () => {
  const result = buildSatelliteCatalog({
    celestrak: catalog(),
    existing: [existing(1)],
    gcat: [{
      jcat: "S00001", plName: null, altNames: null, operator: "Direct Operator",
      manufacturer: "Builder", country: "US", launchDate: null, missionCategory: "Comms",
    }],
    gcatVerifiedAt: "2026-08-10T02:00:00.000Z",
    syncedAt: "2026-08-10T12:00:00.000Z",
  });
  const row = result.rows[0];
  assert.equal(row.operator, "Direct Operator");
  assert.equal(row.operator_source, "gcat");
  assert.equal(row.operator_description, null);
  assert.equal(row.operator_enriched_at, null);
  assert.equal(row.gcat_verified_at, "2026-08-10T02:00:00.000Z");
  assert.equal(row.mission_description, "Evidence-backed mission description.");
  assert.ok(row.source_urls.some(({ label }) => label === "OpenAI mission research"));
});

test("optional-source outages preserve prior provenance and AI evidence", () => {
  const prior = existing(1, {
    source_urls: [
      { label: "GCAT", url: "https://planet4589.org/space/gcat/" },
      { label: "SatNOGS DB", url: "https://db.satnogs.org/satellite/old/" },
      { label: "OpenAI mission research", url: "https://example.com/mission" },
    ],
    gcat_verified_at: "2026-08-09T02:00:00.000Z",
    satnogs_verified_at: "2026-08-09T12:00:00.000Z",
  });
  const row = buildSatelliteCatalog({
    celestrak: catalog(),
    existing: [prior],
    syncedAt: "2026-08-10T12:00:00.000Z",
  }).rows[0];

  assert.equal(row.gcat_verified_at, prior.gcat_verified_at);
  assert.equal(row.satnogs_verified_at, prior.satnogs_verified_at);
  assert.ok(row.source_urls.some(({ label }) => label === "GCAT"));
  assert.ok(row.source_urls.some(({ label }) => label === "SatNOGS DB"));
  assert.ok(row.source_urls.some(({ label }) => label === "OpenAI mission research"));
});

test("ambiguous SatNOGS matches are ignored without excluding CelesTrak rows", () => {
  const shared = {
    norad_cat_id: 1, norad_follow_id: null, name: "SAT-1", names: null,
    status: "alive", launched: null, countries: null, operator: null,
    website: null, updated: "2026-08-10T00:00:00Z",
  };
  const result = buildSatelliteCatalog({
    celestrak: catalog(),
    satnogs: [
      { ...shared, sat_id: "first" },
      { ...shared, sat_id: "second" },
    ],
    syncedAt: "2026-08-10T12:00:00.000Z",
  });

  assert.equal(result.rows.length, MINIMUM_ACTIVE_CATALOG_SIZE);
  assert.equal(result.rows[0].satnogs_id, null);
  assert.equal(result.metrics.ambiguousSatnogsRecords, 2);
});

test("GCAT aliases take precedence over SatNOGS aliases", () => {
  const row = buildSatelliteCatalog({
    celestrak: catalog(),
    satnogs: [{
      sat_id: "satnogs-1", norad_cat_id: 1, norad_follow_id: null, name: "SAT-1",
      names: "Community Alias", status: "alive", launched: null, countries: null,
      operator: null, website: "javascript:alert(1)", updated: "2026-08-10T00:00:00Z",
    }],
    gcat: [{
      jcat: "S00001", plName: "GCAT Alias", altNames: null, operator: null,
      manufacturer: null, country: null, launchDate: null, missionCategory: null,
    }],
    syncedAt: "2026-08-10T12:00:00.000Z",
  }).rows[0];

  assert.equal(row.alternate_name, "GCAT Alias");
  assert.ok(!row.source_urls.some(({ label }) => label === "Mission website"));
});

test("a duplicated SatNOGS ID cannot be assigned to two NORAD rows", () => {
  const base = {
    sat_id: "duplicated", norad_follow_id: null, name: "Satellite", names: null,
    status: "alive", launched: null, countries: null, operator: null,
    website: null, updated: "2026-08-10T00:00:00Z",
  };
  const result = buildSatelliteCatalog({
    celestrak: catalog(),
    satnogs: [
      { ...base, norad_cat_id: 1 },
      { ...base, norad_cat_id: 2 },
    ],
    syncedAt: "2026-08-10T12:00:00.000Z",
  });
  assert.equal(result.rows[0].satnogs_id, null);
  assert.equal(result.rows[1].satnogs_id, null);
});

test("SatNOGS ID reassignment cannot leave two rows claiming the same optional ID", () => {
  const result = buildSatelliteCatalog({
    celestrak: catalog(),
    satnogs: [{
      sat_id: "satnogs-1", norad_cat_id: 2, norad_follow_id: null, name: "SAT-2",
      names: null, status: "alive", launched: null, countries: null, operator: null,
      website: null, updated: "2026-08-10T00:00:00Z",
    }],
    existing: [existing(1, { satnogs_id: "satnogs-1" })],
    syncedAt: "2026-08-10T12:00:00.000Z",
  });
  assert.equal(result.rows[0].satnogs_id, null);
  assert.equal(result.rows[1].satnogs_id, "satnogs-1");
  assert.deepEqual(result.satnogsReassignments, [{
    satnogsId: "satnogs-1",
    previousNoradId: 1,
    nextNoradId: 2,
  }]);
});

test("rejects truncated, duplicate, and unexpectedly shrunken authoritative catalogs", () => {
  assert.throws(() => validateAuthoritativeCatalog(catalog().slice(0, -1)));
  assert.throws(() => validateAuthoritativeCatalog([...catalog(), orbit(1)]));
  assert.throws(() => validateAuthoritativeCatalog(catalog(), 13_000));
});
