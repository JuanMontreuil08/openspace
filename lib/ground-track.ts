export type GroundTrackPoint = {
  latitude: number;
  longitude: number;
};

export type GroundTrackSample = GroundTrackPoint & {
  offsetMinutes: number;
};

export function findGroundTrackSample(
  samples: GroundTrackSample[],
  offsetMinutes: number,
) {
  if (samples.length === 0) return null;
  return samples.reduce((closest, sample) =>
    Math.abs(sample.offsetMinutes - offsetMinutes) <
    Math.abs(closest.offsetMinutes - offsetMinutes)
      ? sample
      : closest,
  );
}

export function formatGroundTrackOffset(offsetMinutes: number) {
  if (offsetMinutes === 0) return "Now";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const value = Number.isInteger(absoluteMinutes)
    ? String(absoluteMinutes)
    : absoluteMinutes.toFixed(1);
  return offsetMinutes < 0 ? `${value} min ago` : `In ${value} min`;
}
