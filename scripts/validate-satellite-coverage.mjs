import { readFile } from "node:fs/promises";
import { json2satrec, propagate } from "satellite.js";

const SATNOGS_URL = "https://db.satnogs.org/api/satellites/?format=json";
const CELESTRAK_URL =
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=JSON";
const GCAT_URLS = {
  objects: "https://planet4589.org/space/gcat/tsv/cat/satcat.tsv",
  extendedObjects:
    "https://planet4589.org/space/gcat/tsv/cat/satcat100k.tsv",
  payloads: "https://planet4589.org/space/gcat/tsv/cat/psatcat.tsv",
  extendedPayloads:
    "https://planet4589.org/space/gcat/tsv/cat/psatcat100k.tsv",
  organizations: "https://planet4589.org/space/gcat/tsv/tables/orgs.tsv",
};

function getArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function loadJson(file, url) {
  return JSON.parse(await loadText(file, url));
}

async function loadText(file, url) {
  if (file) {
    return readFile(file, "utf8");
  }

  const response = await fetch(url, {
    headers: { "User-Agent": "OpenSpace satellite coverage validator/0.1" },
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.text();
}

function parseTsv(text) {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.startsWith("#"));
  if (headerIndex === -1) throw new Error("GCAT TSV header was not found.");
  const headers = lines[headerIndex].slice(1).split("\t");

  return lines
    .slice(headerIndex + 1)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const values = line.split("\t");
      return Object.fromEntries(
        headers.map((header, index) => [
          header,
          values[index]?.trim() ?? "",
        ]),
      );
    });
}

function canonicalNoradId(satellite) {
  return Number(satellite.norad_follow_id ?? satellite.norad_cat_id);
}

function hasUsefulValue(value) {
  return (
    value !== null &&
    value !== undefined &&
    value !== "" &&
    value !== "-" &&
    value !== "?" &&
    value !== "None" &&
    value !== "Unknown"
  );
}

function gcatId(satellite) {
  return `S${String(canonicalNoradId(satellite)).padStart(5, "0")}`;
}

function resolveOrganizations(value, organizationsByCode) {
  if (!hasUsefulValue(value)) return [];
  return value
    .split("/")
    .map((code) => organizationsByCode.get(code.replace(/\?$/, "")))
    .filter(Boolean);
}

function percentage(count, total) {
  return total === 0 ? "0.0%" : `${((count / total) * 100).toFixed(1)}%`;
}

function fieldCoverage(records, label, source, getValue) {
  const available = records.filter(getValue).length;
  return {
    field: label,
    source,
    available,
    coverage: percentage(available, records.length),
  };
}

const satnogsFile = getArgument("--satnogs-file");
const celestrakFile = getArgument("--celestrak-file");
const [
  satnogsSatellites,
  celestrakSatellites,
  gcatObjectText,
  gcatExtendedObjectText,
  gcatPayloadText,
  gcatExtendedPayloadText,
  gcatOrganizationsText,
] = await Promise.all([
  loadJson(satnogsFile, SATNOGS_URL),
  loadJson(celestrakFile, CELESTRAK_URL),
  loadText(getArgument("--gcat-objects-file"), GCAT_URLS.objects),
  loadText(
    getArgument("--gcat-extended-objects-file"),
    GCAT_URLS.extendedObjects,
  ),
  loadText(getArgument("--gcat-payloads-file"), GCAT_URLS.payloads),
  loadText(
    getArgument("--gcat-extended-payloads-file"),
    GCAT_URLS.extendedPayloads,
  ),
  loadText(
    getArgument("--gcat-organizations-file"),
    GCAT_URLS.organizations,
  ),
]);

if (!Array.isArray(satnogsSatellites) || !Array.isArray(celestrakSatellites)) {
  throw new Error("Both catalog endpoints must return JSON arrays.");
}

const celestrakByNorad = new Map(
  celestrakSatellites.map((satellite) => [
    Number(satellite.NORAD_CAT_ID),
    satellite,
  ]),
);
const gcatObjectsById = new Map(
  [...parseTsv(gcatObjectText), ...parseTsv(gcatExtendedObjectText)].map(
    (object) => [object.JCAT, object],
  ),
);
const gcatPayloadsById = new Map(
  [...parseTsv(gcatPayloadText), ...parseTsv(gcatExtendedPayloadText)].map(
    (payload) => [payload.JCAT, payload],
  ),
);
const gcatOrganizationsByCode = new Map(
  parseTsv(gcatOrganizationsText).map((organization) => [
    organization.Code,
    organization,
  ]),
);
const operationalSatellites = satnogsSatellites.filter(
  (satellite) => satellite.status === "alive",
);
const satnogsByCanonicalNorad = Map.groupBy(
  operationalSatellites.filter((satellite) =>
    Number.isFinite(canonicalNoradId(satellite)),
  ),
  canonicalNoradId,
);
const matchedSatellites = operationalSatellites.filter((satellite) =>
  celestrakByNorad.has(canonicalNoradId(satellite)),
);
const ambiguousGroups = [...satnogsByCanonicalNorad.entries()].filter(
  ([noradId, satellites]) =>
    celestrakByNorad.has(noradId) && satellites.length > 1,
);
const usableSatellites = matchedSatellites.filter(
  (satellite) =>
    satnogsByCanonicalNorad.get(canonicalNoradId(satellite))?.length === 1,
);
const catalogSatellites = usableSatellites.filter((satellite) => {
  const object = gcatObjectsById.get(gcatId(satellite));
  const payload = gcatPayloadsById.get(gcatId(satellite));
  return (
    object?.Type.trim().startsWith("P") &&
    hasUsefulValue(object.LDate) &&
    hasUsefulValue(payload?.Category) &&
    resolveOrganizations(object.Owner, gcatOrganizationsByCode).length > 0
  );
});

const propagatableNoradIds = new Set();
const propagationDate = new Date();
for (const satellite of catalogSatellites) {
  const noradId = canonicalNoradId(satellite);
  try {
    const satrec = json2satrec(celestrakByNorad.get(noradId));
    const result = propagate(satrec, propagationDate);
    if (result.position && typeof result.position !== "boolean") {
      propagatableNoradIds.add(noradId);
    }
  } catch {
    // Counted as unavailable in the coverage report below.
  }
}

const coverage = [
  fieldCoverage(catalogSatellites, "name", "SatNOGS / CelesTrak", () => true),
  fieldCoverage(
    catalogSatellites,
    "alternateName",
    "SatNOGS + GCAT",
    (satellite) => {
      const object = gcatObjectsById.get(gcatId(satellite));
      const primaryName = satellite.name.toLocaleLowerCase();
      return [satellite.names, object?.PLName, object?.AltNames].some(
        (value) =>
          hasUsefulValue(value) &&
          value.toLocaleLowerCase() !== primaryName,
      );
    },
  ),
  fieldCoverage(catalogSatellites, "noradId", "SatNOGS ↔ CelesTrak", () => true),
  fieldCoverage(catalogSatellites, "cosparId", "CelesTrak", (satellite) =>
    hasUsefulValue(
      celestrakByNorad.get(canonicalNoradId(satellite))?.OBJECT_ID,
    ),
  ),
  fieldCoverage(catalogSatellites, "status", "SatNOGS", () => true),
  fieldCoverage(catalogSatellites, "launchDate", "SatNOGS + GCAT", (satellite) =>
    hasUsefulValue(
      satellite.launched ?? gcatObjectsById.get(gcatId(satellite))?.LDate,
    ),
  ),
  fieldCoverage(catalogSatellites, "country", "GCAT", (satellite) =>
    resolveOrganizations(
      gcatObjectsById.get(gcatId(satellite))?.State,
      gcatOrganizationsByCode,
    ).length > 0,
  ),
  fieldCoverage(catalogSatellites, "operator", "GCAT", (satellite) =>
    resolveOrganizations(
      gcatObjectsById.get(gcatId(satellite))?.Owner,
      gcatOrganizationsByCode,
    ).length > 0,
  ),
  fieldCoverage(catalogSatellites, "manufacturer", "GCAT", (satellite) =>
    resolveOrganizations(
      gcatObjectsById.get(gcatId(satellite))?.Manufacturer,
      gcatOrganizationsByCode,
    ).length > 0,
  ),
  fieldCoverage(catalogSatellites, "function", "GCAT category", (satellite) =>
    hasUsefulValue(gcatPayloadsById.get(gcatId(satellite))?.Category),
  ),
  fieldCoverage(
    catalogSatellites,
    "operatorDescription",
    "Generated from GCAT organization metadata",
    (satellite) =>
      resolveOrganizations(
        gcatObjectsById.get(gcatId(satellite))?.Owner,
        gcatOrganizationsByCode,
      ).length > 0,
  ),
  fieldCoverage(
    catalogSatellites,
    "dataCenterRelation",
    "OpenSpace editorial field",
    () => false,
  ),
  fieldCoverage(catalogSatellites, "inclination", "CelesTrak", (satellite) =>
    Number.isFinite(
      celestrakByNorad.get(canonicalNoradId(satellite))?.INCLINATION,
    ),
  ),
  fieldCoverage(catalogSatellites, "period", "CelesTrak", (satellite) => {
    const meanMotion =
      celestrakByNorad.get(canonicalNoradId(satellite))?.MEAN_MOTION;
    return Number.isFinite(meanMotion) && meanMotion > 0;
  }),
  fieldCoverage(catalogSatellites, "livePosition", "CelesTrak OMM", (satellite) =>
    propagatableNoradIds.has(canonicalNoradId(satellite)),
  ),
  fieldCoverage(catalogSatellites, "sources", "Constructed URLs", () => true),
];

console.log("\nOpenSpace satellite coverage validation\n");
console.table([
  { metric: "SatNOGS catalog records", count: satnogsSatellites.length },
  { metric: "SatNOGS operational records", count: operationalSatellites.length },
  { metric: "CelesTrak active records", count: celestrakSatellites.length },
  { metric: "Matched operational records", count: matchedSatellites.length },
  {
    metric: "Excluded ambiguous records",
    count: ambiguousGroups.reduce(
      (total, [, satellites]) => total + satellites.length,
      0,
    ),
  },
  { metric: "Usable unique matches", count: usableSatellites.length },
  {
    metric: "GCAT-confirmed payloads with complete card metadata",
    count: catalogSatellites.length,
  },
  {
    metric: "Excluded non-payload or incomplete GCAT records",
    count: usableSatellites.length - catalogSatellites.length,
  },
  {
    metric: "Operational records without active orbit",
    count: operationalSatellites.length - matchedSatellites.length,
  },
]);

console.log("\nCard field coverage for GCAT-confirmed payloads\n");
console.table(coverage);

if (ambiguousGroups.length > 0) {
  console.log("\nAmbiguous NORAD examples (excluded)\n");
  console.table(
    ambiguousGroups.slice(0, 10).map(([noradId, satellites]) => ({
      noradId,
      satnogsRecords: satellites
        .map((satellite) => `${satellite.name} (${satellite.sat_id})`)
        .join(" | "),
    })),
  );
}

const starcloud = catalogSatellites.find(
  (satellite) => canonicalNoradId(satellite) === 66303,
);
console.log(
  `\nStarcloud-1 canonical join: ${starcloud ? "valid" : "not found"}\n`,
);
