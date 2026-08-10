import type { OrbitalElements, SourceLink } from "./types";
import { json2satrec, propagate } from "satellite.js";

export const MINIMUM_ACTIVE_CATALOG_SIZE = 10_000;
export const MINIMUM_RELATIVE_CATALOG_SIZE = 0.8;

export type SatnogsCatalogRecord = {
  sat_id: string;
  norad_cat_id: number | null;
  norad_follow_id: number | null;
  name: string;
  names: string | null;
  status: string;
  launched: string | null;
  countries: string | null;
  operator: string | null;
  website: string | null;
  updated: string;
};

export type GcatCatalogMetadata = {
  jcat: string;
  plName: string | null;
  altNames: string | null;
  operator: string | null;
  manufacturer: string | null;
  country: string | null;
  launchDate: string | null;
  missionCategory: string | null;
};

export type ExistingCatalogRecord = {
  norad_id: number;
  satnogs_id: string | null;
  alternate_name: string | null;
  operator: string | null;
  operator_source: "gcat" | "satnogs" | "ai" | "editorial" | null;
  operator_description: string | null;
  manufacturer: string | null;
  country: string | null;
  launch_date: string | null;
  mission_category: string | null;
  mission_description: string | null;
  data_center_relation: string | null;
  source_urls: SourceLink[];
  mission_enriched_at: string | null;
  operator_enriched_at: string | null;
  gcat_verified_at: string | null;
  satnogs_verified_at: string | null;
};

export type SatelliteCatalogRow = ExistingCatalogRecord & {
  cospar_id: string | null;
  name: string;
  status: "operational";
  inclination_deg: number;
  period_minutes: number;
  orbital_elements: OrbitalElements;
  tle_line_1: null;
  tle_line_2: null;
  source_updated_at: string;
  synced_at: string;
};

type BuildCatalogInput = {
  celestrak: OrbitalElements[];
  satnogs?: SatnogsCatalogRecord[];
  gcat?: GcatCatalogMetadata[];
  existing?: ExistingCatalogRecord[];
  syncedAt: string;
  previousOperationalCount?: number;
  gcatVerifiedAt?: string | null;
};

const CATALOG_SOURCE_LABELS = new Set([
  "CelesTrak",
  "SatNOGS DB",
  "GCAT",
  "Mission website",
]);

function usefulValue(value: string | null | undefined) {
  if (!value || value === "-" || value === "?" || value === "None" || value === "Unknown") {
    return null;
  }
  return value;
}

function canonicalNoradId(satellite: SatnogsCatalogRecord) {
  return satellite.norad_follow_id ?? satellite.norad_cat_id;
}

function gcatIdForNorad(noradId: number) {
  return `S${String(noradId).padStart(5, "0")}`;
}

function celestrakObjectUrl(noradId: number) {
  return `https://celestrak.org/NORAD/elements/gp.php?CATNR=${noradId}&FORMAT=JSON`;
}

function safeHttpUrl(value: string | null | undefined) {
  const useful = usefulValue(value);
  if (!useful) return null;
  try {
    const url = new URL(useful);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function sourceUpdatedAt(epoch: string) {
  const parsed = new Date(epoch.endsWith("Z") ? epoch : `${epoch}Z`);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid CelesTrak epoch: ${epoch}`);
  }
  return parsed.toISOString();
}

function uniqueSources(sources: SourceLink[]) {
  return [
    ...new Map(
      sources.map((source) => [`${source.label}\u0000${source.url}`, source]),
    ).values(),
  ];
}

function catalogSources(
  orbitalElements: OrbitalElements,
  satnogs: SatnogsCatalogRecord | null,
) {
  const sources: SourceLink[] = [
    {
      label: "CelesTrak",
      url: celestrakObjectUrl(orbitalElements.NORAD_CAT_ID),
    },
  ];
  if (satnogs) {
    sources.push({
      label: "SatNOGS DB",
      url: `https://db.satnogs.org/satellite/${satnogs.sat_id}/`,
    });
    const website = safeHttpUrl(satnogs.website);
    if (website) sources.push({ label: "Mission website", url: website });
  }
  return sources;
}

function alternateName(
  primaryName: string,
  satnogs: SatnogsCatalogRecord | null,
  gcat: GcatCatalogMetadata | null,
  existing: ExistingCatalogRecord | null,
) {
  const normalizedPrimary = primaryName.toLocaleLowerCase();
  const preferredAliases = [gcat?.plName, gcat?.altNames].some(usefulValue)
    ? [gcat?.plName, gcat?.altNames]
    : [satnogs?.names];
  const values = preferredAliases
    .flatMap((value) => usefulValue(value)?.split(/,\s*/) ?? [])
    .map((value) => value.trim())
    .filter((value) => value && value.toLocaleLowerCase() !== normalizedPrimary);
  const unique = [...new Map(values.map((value) => [value.toLocaleLowerCase(), value])).values()];
  return unique.length > 0 ? unique.join(", ") : existing?.alternate_name ?? null;
}

export function validateAuthoritativeCatalog(
  celestrak: OrbitalElements[],
  previousOperationalCount = 0,
) {
  if (celestrak.length < MINIMUM_ACTIVE_CATALOG_SIZE) {
    throw new Error(
      `CelesTrak active catalog contained ${celestrak.length} records; expected at least ${MINIMUM_ACTIVE_CATALOG_SIZE}.`,
    );
  }
  if (
    previousOperationalCount >= MINIMUM_ACTIVE_CATALOG_SIZE &&
    celestrak.length < previousOperationalCount * MINIMUM_RELATIVE_CATALOG_SIZE
  ) {
    throw new Error(
      `CelesTrak active catalog shrank from ${previousOperationalCount} to ${celestrak.length} records.`,
    );
  }
  const noradIds = new Set<number>();
  for (const record of celestrak) {
    if (noradIds.has(record.NORAD_CAT_ID)) {
      throw new Error(`CelesTrak returned duplicate NORAD ID ${record.NORAD_CAT_ID}.`);
    }
    noradIds.add(record.NORAD_CAT_ID);
    const epoch = new Date(
      record.EPOCH.endsWith("Z") ? record.EPOCH : `${record.EPOCH}Z`,
    );
    if (
      !Number.isFinite(epoch.getTime()) ||
      record.ECCENTRICITY < 0 ||
      record.ECCENTRICITY >= 1 ||
      record.INCLINATION < 0 ||
      record.INCLINATION > 180
    ) {
      throw new Error(`CelesTrak returned invalid orbital elements for NORAD ${record.NORAD_CAT_ID}.`);
    }
    const propagated = propagate(json2satrec(record), new Date());
    if (
      !propagated?.position ||
      typeof propagated.position === "boolean"
    ) {
      throw new Error(`CelesTrak orbit for NORAD ${record.NORAD_CAT_ID} cannot be propagated.`);
    }
  }
}

export function buildSatelliteCatalog(input: BuildCatalogInput) {
  const {
    celestrak,
    satnogs = [],
    gcat = [],
    existing = [],
    syncedAt,
    previousOperationalCount = 0,
    gcatVerifiedAt = null,
  } = input;
  const satnogsAvailable = input.satnogs !== undefined;
  const gcatAvailable = input.gcat !== undefined;
  validateAuthoritativeCatalog(celestrak, previousOperationalCount);

  const existingByNorad = new Map(existing.map((record) => [record.norad_id, record]));
  const gcatById = new Map(gcat.map((record) => [record.jcat, record]));
  const satnogsGroups = Map.groupBy(
    satnogs.filter(
      (record) => record.status === "alive" && canonicalNoradId(record) !== null,
    ),
    (record) => canonicalNoradId(record) as number,
  );
  const uniqueSatnogsByNorad = new Map(
    [...satnogsGroups].flatMap(([noradId, records]) =>
      records.length === 1 ? [[noradId, records[0]] as const] : [],
    ),
  );
  const satnogsIdCounts = new Map<string, number>();
  for (const record of uniqueSatnogsByNorad.values()) {
    satnogsIdCounts.set(record.sat_id, (satnogsIdCounts.get(record.sat_id) ?? 0) + 1);
  }
  for (const [noradId, record] of uniqueSatnogsByNorad) {
    if ((satnogsIdCounts.get(record.sat_id) ?? 0) > 1) {
      uniqueSatnogsByNorad.delete(noradId);
    }
  }
  const claimedSatnogsIds = new Map(
    [...uniqueSatnogsByNorad].map(([noradId, record]) => [record.sat_id, noradId]),
  );
  const satnogsReassignments = existing.flatMap((record) => {
    if (!record.satnogs_id) return [];
    const nextNoradId = claimedSatnogsIds.get(record.satnogs_id);
    return nextNoradId && nextNoradId !== record.norad_id
      ? [{
          satnogsId: record.satnogs_id,
          previousNoradId: record.norad_id,
          nextNoradId,
        }]
      : [];
  });

  let satnogsMatches = 0;
  let ambiguousSatnogsRecords = 0;
  let gcatMatches = 0;

  const rows = celestrak.map((orbitalElements): SatelliteCatalogRow => {
    const noradId = orbitalElements.NORAD_CAT_ID;
    const current = existingByNorad.get(noradId) ?? null;
    const satnogsGroup = satnogsGroups.get(noradId) ?? [];
    const satnogsMatch = uniqueSatnogsByNorad.get(noradId) ?? null;
    if (satnogsGroup.length > 1) ambiguousSatnogsRecords += satnogsGroup.length;
    if (satnogsMatch) satnogsMatches += 1;
    const gcatMatch = gcatById.get(gcatIdForNorad(noradId)) ?? null;
    if (gcatMatch) gcatMatches += 1;

    const directOperator =
      usefulValue(gcatMatch?.operator) ?? usefulValue(satnogsMatch?.operator);
    const directOperatorSource = usefulValue(gcatMatch?.operator)
      ? "gcat"
      : usefulValue(satnogsMatch?.operator)
        ? "satnogs"
        : null;
    const operatorChanged = Boolean(
      directOperator && current?.operator && directOperator !== current.operator,
    );
    const operator = directOperator ?? current?.operator ?? null;
    const preservedEvidence = (current?.source_urls ?? []).filter((source) => {
      if (!CATALOG_SOURCE_LABELS.has(source.label)) return true;
      if (source.label === "CelesTrak") return false;
      if (source.label === "GCAT") return !gcatAvailable;
      return !satnogsAvailable;
    });
    const sources = uniqueSources([
      ...catalogSources(orbitalElements, satnogsMatch),
      ...(gcatMatch
        ? [{ label: "GCAT", url: "https://planet4589.org/space/gcat/" }]
        : []),
      ...preservedEvidence.filter(
        (source) => !(operatorChanged && source.label.toLowerCase().includes("operator research")),
      ),
    ]);

    return {
      norad_id: noradId,
      satnogs_id:
        satnogsMatch?.sat_id ??
        (current?.satnogs_id &&
        claimedSatnogsIds.get(current.satnogs_id) !== noradId
          ? null
          : current?.satnogs_id ?? null),
      cospar_id: usefulValue(orbitalElements.OBJECT_ID),
      name: orbitalElements.OBJECT_NAME,
      alternate_name: alternateName(
        orbitalElements.OBJECT_NAME,
        satnogsMatch,
        gcatMatch,
        current,
      ),
      operator,
      operator_source:
        directOperatorSource ?? current?.operator_source ?? null,
      operator_description: operatorChanged
        ? null
        : current?.operator_description ?? null,
      manufacturer:
        usefulValue(gcatMatch?.manufacturer) ?? current?.manufacturer ?? null,
      country:
        usefulValue(gcatMatch?.country) ??
        usefulValue(satnogsMatch?.countries) ??
        current?.country ??
        null,
      launch_date:
        usefulValue(gcatMatch?.launchDate) ??
        usefulValue(satnogsMatch?.launched) ??
        current?.launch_date ??
        null,
      status: "operational",
      mission_category:
        usefulValue(gcatMatch?.missionCategory) ??
        current?.mission_category ??
        null,
      mission_description: current?.mission_description ?? null,
      data_center_relation: current?.data_center_relation ?? null,
      inclination_deg: orbitalElements.INCLINATION,
      period_minutes: 1440 / orbitalElements.MEAN_MOTION,
      orbital_elements: orbitalElements,
      tle_line_1: null,
      tle_line_2: null,
      source_urls: sources,
      mission_enriched_at: current?.mission_enriched_at ?? null,
      operator_enriched_at: operatorChanged
        ? null
        : current?.operator_enriched_at ?? null,
      gcat_verified_at: gcatMatch
        ? gcatVerifiedAt ?? current?.gcat_verified_at ?? null
        : current?.gcat_verified_at ?? null,
      satnogs_verified_at: satnogsMatch
        ? syncedAt
        : current?.satnogs_verified_at ?? null,
      source_updated_at: sourceUpdatedAt(orbitalElements.EPOCH),
      synced_at: syncedAt,
    };
  });

  return {
    rows,
    satnogsReassignments,
    metrics: {
      celestrakRecords: celestrak.length,
      synchronizedRecords: rows.length,
      satnogsRecords: satnogs.length,
      satnogsMatches,
      ambiguousSatnogsRecords,
      gcatRecords: gcat.length,
      gcatMatches,
    },
  };
}
