import type { SatelliteIndexEntry } from "./types";

export const SATELLITE_SEARCH_RESULT_LIMIT = 100;

export function searchSatelliteCatalog<T extends SatelliteIndexEntry>(
  catalog: T[],
  selectedIndex: number,
  query: string,
  limit = SATELLITE_SEARCH_RESULT_LIMIT,
) {
  const indexed = catalog.map((satellite, index) => ({ satellite, index }));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    const selected = indexed[selectedIndex];
    return {
      results: selected ? [selected] : [],
      totalMatches: selected ? 1 : 0,
    };
  }

  const matches = indexed.filter(({ satellite }) =>
    [
      satellite.name,
      satellite.alternateName,
      String(satellite.noradId),
      satellite.operator,
      satellite.country,
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery)),
  );
  return {
    results: matches.slice(0, limit),
    totalMatches: matches.length,
  };
}
