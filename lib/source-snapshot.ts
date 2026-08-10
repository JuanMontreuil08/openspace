export const MAX_CELESTRAK_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1_000;

export type CelestrakSnapshot = {
  fetchedAt: string;
  body: string;
};

export function serializeCelestrakSnapshot(snapshot: CelestrakSnapshot) {
  return JSON.stringify(snapshot);
}

export function parseCelestrakSnapshot(value: string): CelestrakSnapshot {
  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("fetchedAt" in parsed) ||
    typeof parsed.fetchedAt !== "string" ||
    !("body" in parsed) ||
    typeof parsed.body !== "string"
  ) {
    throw new Error("CelesTrak snapshot envelope is invalid.");
  }
  return { fetchedAt: parsed.fetchedAt, body: parsed.body };
}

export function celestrakSnapshotAgeMs(
  fetchedAt: string,
  now = new Date(),
) {
  const fetchedAtMs = new Date(fetchedAt).getTime();
  if (!Number.isFinite(fetchedAtMs)) {
    throw new Error("CelesTrak snapshot timestamp is invalid.");
  }

  const ageMs = now.getTime() - fetchedAtMs;
  if (ageMs < 0 || ageMs > MAX_CELESTRAK_SNAPSHOT_AGE_MS) {
    throw new Error(
      `CelesTrak snapshot is ${Math.round(ageMs / 3_600_000)} hours old; maximum age is 24 hours.`,
    );
  }
  return ageMs;
}
