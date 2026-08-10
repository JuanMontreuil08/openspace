import { readFile } from "node:fs/promises";
import { json2satrec, propagate } from "satellite.js";

import { buildGcatMetadata } from "../lib/gcat-metadata.ts";
import { buildSatelliteCatalog } from "../lib/satellite-catalog.ts";

const SOURCE_URLS = {
  satnogs: "https://db.satnogs.org/api/satellites/?format=json",
  celestrak:
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=JSON",
  objects: "https://planet4589.org/space/gcat/tsv/cat/satcat.tsv",
  extendedObjects: "https://planet4589.org/space/gcat/tsv/cat/satcat100k.tsv",
  payloads: "https://planet4589.org/space/gcat/tsv/cat/psatcat.tsv",
  extendedPayloads:
    "https://planet4589.org/space/gcat/tsv/cat/psatcat100k.tsv",
  organizations: "https://planet4589.org/space/gcat/tsv/tables/orgs.tsv",
  currentCatalog:
    "https://planet4589.org/space/gcat/tsv/derived/currentcat.tsv",
};

function getArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function loadText(file, url) {
  if (file) return readFile(file, "utf8");
  const response = await fetch(url, {
    headers: { "User-Agent": "COOPER satellite coverage validator/0.2" },
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

function percentage(count, total) {
  return total === 0 ? "0.0%" : `${((count / total) * 100).toFixed(1)}%`;
}

function coverage(rows, field, owner, value) {
  const available = rows.filter(value).length;
  return { field, owner, available, coverage: percentage(available, rows.length) };
}

const fileArguments = {
  satnogs: "--satnogs-file",
  celestrak: "--celestrak-file",
  objects: "--gcat-objects-file",
  extendedObjects: "--gcat-extended-objects-file",
  payloads: "--gcat-payloads-file",
  extendedPayloads: "--gcat-extended-payloads-file",
  organizations: "--gcat-organizations-file",
  currentCatalog: "--gcat-current-catalog-file",
};
const loaded = Object.fromEntries(
  await Promise.all(
    Object.entries(SOURCE_URLS).map(async ([key, url]) => [
      key,
      await loadText(getArgument(fileArguments[key]), url),
    ]),
  ),
);
const celestrak = JSON.parse(loaded.celestrak);
const satnogs = JSON.parse(loaded.satnogs);
if (!Array.isArray(celestrak) || !Array.isArray(satnogs)) {
  throw new Error("CelesTrak and SatNOGS must return JSON arrays.");
}

const gcat = buildGcatMetadata({
  objects: loaded.objects,
  extendedObjects: loaded.extendedObjects,
  payloads: loaded.payloads,
  extendedPayloads: loaded.extendedPayloads,
  organizations: loaded.organizations,
  currentCatalog: loaded.currentCatalog,
});
const { rows, metrics } = buildSatelliteCatalog({
  celestrak,
  satnogs,
  gcat,
  syncedAt: new Date().toISOString(),
});
const serializedCatalogBytes = Buffer.byteLength(JSON.stringify(rows));

let propagatable = 0;
let staleEpochs = 0;
const now = new Date();
for (const row of rows) {
  try {
    const result = propagate(json2satrec(row.orbital_elements), now);
    if (result.position && typeof result.position !== "boolean") propagatable += 1;
  } catch {
    // Reported in the propagation coverage below.
  }
  if (now.getTime() - new Date(row.source_updated_at).getTime() > 3.5 * 86_400_000) {
    staleEpochs += 1;
  }
}

const fields = [
  coverage(rows, "name", "CelesTrak", (row) => Boolean(row.name)),
  coverage(rows, "NORAD ID", "CelesTrak", (row) => row.norad_id > 0),
  coverage(rows, "COSPAR ID", "CelesTrak", (row) => Boolean(row.cospar_id)),
  coverage(rows, "orbit / ground track", "CelesTrak", (row) =>
    Number.isFinite(row.orbital_elements.MEAN_MOTION),
  ),
  coverage(rows, "operator", "GCAT → SatNOGS → AI", (row) => Boolean(row.operator)),
  coverage(rows, "manufacturer", "GCAT", (row) => Boolean(row.manufacturer)),
  coverage(rows, "country", "GCAT → SatNOGS", (row) => Boolean(row.country)),
  coverage(rows, "launch date", "GCAT → SatNOGS", (row) => Boolean(row.launch_date)),
  coverage(rows, "mission category", "GCAT", (row) => Boolean(row.mission_category)),
  coverage(rows, "AI mission description", "AI on demand", (row) =>
    Boolean(row.mission_description),
  ),
];

console.log("\nCOOPER CelesTrak-first catalog validation\n");
console.table([
  { metric: "CelesTrak authoritative rows", count: metrics.celestrakRecords },
  { metric: "Rows produced for synchronization", count: metrics.synchronizedRecords },
  { metric: "SatNOGS optional matches", count: metrics.satnogsMatches },
  { metric: "Ambiguous SatNOGS records ignored", count: metrics.ambiguousSatnogsRecords },
  { metric: "GCAT optional matches", count: metrics.gcatMatches },
  { metric: "Propagatable current positions", count: propagatable },
  { metric: "Orbit epochs older than 3.5 days", count: staleEpochs },
  {
    metric: "Serialized full catalog (MiB)",
    count: Number((serializedCatalogBytes / 1024 / 1024).toFixed(2)),
  },
]);
console.log("\nField coverage and explicit ownership\n");
console.table(fields);

if (rows.length !== celestrak.length || propagatable !== rows.length) {
  process.exitCode = 1;
}
