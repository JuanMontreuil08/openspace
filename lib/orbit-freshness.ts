export const ORBIT_STALE_AFTER_MS = 3.5 * 86_400_000;

export function getOrbitFreshness(epochValue: string, now = Date.now()) {
  const epoch = new Date(epochValue);
  if (!Number.isFinite(epoch.getTime())) {
    return { epoch: null, ageLabel: null, isStale: false };
  }

  const ageMs = Math.max(0, now - epoch.getTime());
  const minutes = Math.floor(ageMs / 60_000);
  let ageLabel: string;
  if (minutes < 60) {
    ageLabel = minutes <= 1 ? "just updated" : `${minutes} minutes old`;
  } else {
    const hours = Math.floor(ageMs / 3_600_000);
    if (hours < 48) {
      ageLabel = `${hours} ${hours === 1 ? "hour" : "hours"} old`;
    } else {
      ageLabel = `${Math.floor(ageMs / 86_400_000)} days old`;
    }
  }

  return { epoch, ageLabel, isStale: ageMs > ORBIT_STALE_AFTER_MS };
}
