export type SatelliteIdentity = {
  norad_id: number;
  satnogs_id: string;
};

export type SatelliteIdentityConflict = {
  reason:
    | "duplicate_incoming_satnogs_id"
    | "duplicate_incoming_norad_id"
    | "norad_id_owned_by_another_satnogs_id";
  noradId: number;
  satnogsId: string;
  conflictingSatnogsId?: string;
};

export type NoradReassignment = {
  satnogsId: string;
  previousNoradId: number;
  nextNoradId: number;
};

function duplicateValues<T>(values: T[]) {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([value]) => value),
  );
}

export function reconcileSatelliteIdentities<T extends SatelliteIdentity>(
  incomingRows: T[],
  existingRows: SatelliteIdentity[],
) {
  const existingBySatnogsId = new Map(
    existingRows.map((row) => [row.satnogs_id, row]),
  );
  const existingByNoradId = new Map(
    existingRows.map((row) => [row.norad_id, row]),
  );
  const duplicateSatnogsIds = duplicateValues(
    incomingRows.map((row) => row.satnogs_id),
  );
  const duplicateNoradIds = duplicateValues(
    incomingRows.map((row) => row.norad_id),
  );
  const acceptedRows: T[] = [];
  const conflicts: SatelliteIdentityConflict[] = [];
  const reassignments: NoradReassignment[] = [];

  for (const row of incomingRows) {
    if (duplicateSatnogsIds.has(row.satnogs_id)) {
      conflicts.push({
        reason: "duplicate_incoming_satnogs_id",
        noradId: row.norad_id,
        satnogsId: row.satnogs_id,
      });
      continue;
    }

    if (duplicateNoradIds.has(row.norad_id)) {
      conflicts.push({
        reason: "duplicate_incoming_norad_id",
        noradId: row.norad_id,
        satnogsId: row.satnogs_id,
      });
      continue;
    }

    const targetNoradOwner = existingByNoradId.get(row.norad_id);
    if (
      targetNoradOwner &&
      targetNoradOwner.satnogs_id !== row.satnogs_id
    ) {
      conflicts.push({
        reason: "norad_id_owned_by_another_satnogs_id",
        noradId: row.norad_id,
        satnogsId: row.satnogs_id,
        conflictingSatnogsId: targetNoradOwner.satnogs_id,
      });
      continue;
    }

    const existing = existingBySatnogsId.get(row.satnogs_id);
    if (existing && existing.norad_id !== row.norad_id) {
      reassignments.push({
        satnogsId: row.satnogs_id,
        previousNoradId: existing.norad_id,
        nextNoradId: row.norad_id,
      });
    }

    acceptedRows.push(row);
  }

  return { acceptedRows, conflicts, reassignments };
}
