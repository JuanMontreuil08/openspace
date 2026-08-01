# Satellite sync identity reconciliation

- **Symptom:** `sync-satellite-catalog` failed with PostgreSQL error `23505` when SatNOGS ID `TEAW-1621-8543-0676-6317` changed from NORAD `69874` to `69897`.
- **Root cause:** The task upserted on `norad_id`, even though SatNOGS can correct that value. PostgreSQL treated the corrected NORAD as a new row and rejected the already-existing unique `satnogs_id`.
- **Fix:** Treat `satnogs_id` as the stable upsert identity, reconcile safe NORAD changes before writing, preserve editorial fields by SatNOGS identity, and exclude/log irreconcilable identity collisions.
- **Evidence:** The regression scenario `69874 -> 69897` is accepted as one reassignment. Duplicate incoming identities and NORAD IDs owned by another SatNOGS record are rejected before the batch upsert.
- **Regression test:** `lib/satellite-identity.test.mjs`.
- **Related:** The task now returns `identityConflicts` and `reassignedNoradRecords` counters.
- **Status:** DONE
