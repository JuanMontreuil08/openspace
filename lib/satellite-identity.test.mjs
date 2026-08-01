import assert from "node:assert/strict";
import test from "node:test";

import { reconcileSatelliteIdentities } from "./satellite-identity.ts";

test("accepts a NORAD reassignment for the same SatNOGS identity", () => {
  const result = reconcileSatelliteIdentities(
    [{ norad_id: 69897, satnogs_id: "TEAW-1621-8543-0676-6317" }],
    [{ norad_id: 69874, satnogs_id: "TEAW-1621-8543-0676-6317" }],
  );

  assert.equal(result.acceptedRows.length, 1);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.reassignments, [
    {
      satnogsId: "TEAW-1621-8543-0676-6317",
      previousNoradId: 69874,
      nextNoradId: 69897,
    },
  ]);
});

test("rejects a NORAD owned by a different SatNOGS identity", () => {
  const result = reconcileSatelliteIdentities(
    [{ norad_id: 69897, satnogs_id: "NEW-SATNOGS-ID" }],
    [{ norad_id: 69897, satnogs_id: "EXISTING-SATNOGS-ID" }],
  );

  assert.deepEqual(result.acceptedRows, []);
  assert.equal(result.conflicts[0]?.reason, "norad_id_owned_by_another_satnogs_id");
});

test("rejects duplicate SatNOGS identities in the incoming catalog", () => {
  const result = reconcileSatelliteIdentities(
    [
      { norad_id: 100, satnogs_id: "DUPLICATE" },
      { norad_id: 101, satnogs_id: "DUPLICATE" },
    ],
    [],
  );

  assert.deepEqual(result.acceptedRows, []);
  assert.equal(result.conflicts.length, 2);
  assert.ok(
    result.conflicts.every(
      (conflict) => conflict.reason === "duplicate_incoming_satnogs_id",
    ),
  );
});

test("keeps an unchanged identity idempotent", () => {
  const identity = { norad_id: 66303, satnogs_id: "STARCLOUD" };
  const result = reconcileSatelliteIdentities([identity], [identity]);

  assert.deepEqual(result.acceptedRows, [identity]);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.reassignments, []);
});
