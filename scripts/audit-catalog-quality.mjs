import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { createClient } from "@supabase/supabase-js";
import { json2satrec, propagate } from "satellite.js";

if (existsSync(".env.local")) loadEnvFile(".env.local");

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) throw new Error("Supabase credentials are required.");

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const PAGE_SIZE = 1_000;
const columns = [
  "norad_id", "satnogs_id", "cospar_id", "name", "alternate_name",
  "operator", "operator_source", "operator_description", "manufacturer",
  "country", "launch_date", "status", "mission_category",
  "mission_description", "data_center_relation", "inclination_deg",
  "period_minutes", "orbital_elements", "tle_line_1", "tle_line_2",
  "source_urls", "mission_enriched_at", "operator_enriched_at",
  "gcat_verified_at", "satnogs_verified_at", "source_updated_at", "synced_at",
].join(",");

const rows = [];
for (let from = 0; ; from += PAGE_SIZE) {
  const { data, error } = await supabase
    .from("satellites")
    .select(columns)
    .eq("status", "operational")
    .order("norad_id", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);
  if (error) throw error;
  rows.push(...(data ?? []));
  if ((data?.length ?? 0) < PAGE_SIZE) break;
}

const missing = (value) =>
  value === null || value === undefined ||
  (typeof value === "string" && value.trim() === "");
const auditedFields = [
  "satnogs_id", "cospar_id", "alternate_name", "operator",
  "operator_description", "manufacturer", "country", "launch_date",
  "mission_category", "mission_description", "data_center_relation",
  "tle_line_1", "tle_line_2", "mission_enriched_at",
  "operator_enriched_at", "gcat_verified_at", "satnogs_verified_at",
];

console.log("\nOperational catalog overview\n");
console.table([
  { metric: "Operational rows", value: rows.length },
  {
    metric: "Distinct NORAD IDs",
    value: new Set(rows.map((row) => row.norad_id)).size,
  },
  {
    metric: "Distinct sync timestamps",
    value: new Set(rows.map((row) => row.synced_at)).size,
  },
]);

console.log("\nNull or blank fields\n");
console.table(auditedFields.map((field) => {
  const count = rows.filter((row) => missing(row[field])).length;
  return {
    field,
    nulls: count,
    populated: rows.length - count,
    coverage: `${(((rows.length - count) / rows.length) * 100).toFixed(2)}%`,
  };
}));

const operatorSources = Map.groupBy(rows, (row) => row.operator_source ?? "null");
console.log("\nOperator provenance\n");
console.table([...operatorSources].map(([source, sourceRows]) => ({
  source,
  rows: sourceRows.length,
})));

const sourceCounts = new Map();
for (const row of rows) {
  for (const source of Array.isArray(row.source_urls) ? row.source_urls : []) {
    const label = source?.label ?? "invalid";
    sourceCounts.set(label, (sourceCounts.get(label) ?? 0) + 1);
  }
}
console.log("\nSource-link coverage\n");
console.table([...sourceCounts].map(([source, count]) => ({ source, count })));

const now = Date.now();
const anomalyCounts = {
  missingName: 0,
  missingOrbit: 0,
  invalidOrbitDomain: 0,
  unpropagatableOrbit: 0,
  staleOrbitOver3_5Days: 0,
  orbitNoradMismatch: 0,
  operatorWithoutProvenance: 0,
  provenanceWithoutOperator: 0,
  missionTextTimestampMismatch: 0,
  operatorTextTimestampMismatch: 0,
  missingCelestrakSource: 0,
};

for (const row of rows) {
  if (missing(row.name)) anomalyCounts.missingName += 1;
  const orbit = row.orbital_elements;
  if (!orbit) {
    anomalyCounts.missingOrbit += 1;
  } else {
    if (
      orbit.ECCENTRICITY < 0 || orbit.ECCENTRICITY >= 1 ||
      orbit.INCLINATION < 0 || orbit.INCLINATION > 180 ||
      orbit.MEAN_MOTION <= 0
    ) anomalyCounts.invalidOrbitDomain += 1;
    if (orbit.NORAD_CAT_ID !== row.norad_id) anomalyCounts.orbitNoradMismatch += 1;
    try {
      const result = propagate(json2satrec(orbit), new Date());
      if (!result?.position || typeof result.position === "boolean") {
        anomalyCounts.unpropagatableOrbit += 1;
      }
    } catch {
      anomalyCounts.unpropagatableOrbit += 1;
    }
  }
  const sourceAge = now - new Date(row.source_updated_at).getTime();
  if (sourceAge > 3.5 * 86_400_000) anomalyCounts.staleOrbitOver3_5Days += 1;
  if (!missing(row.operator) && missing(row.operator_source)) {
    anomalyCounts.operatorWithoutProvenance += 1;
  }
  if (missing(row.operator) && !missing(row.operator_source)) {
    anomalyCounts.provenanceWithoutOperator += 1;
  }
  if (missing(row.mission_description) !== missing(row.mission_enriched_at)) {
    anomalyCounts.missionTextTimestampMismatch += 1;
  }
  if (missing(row.operator_description) !== missing(row.operator_enriched_at)) {
    anomalyCounts.operatorTextTimestampMismatch += 1;
  }
  if (!(row.source_urls ?? []).some((source) => source?.label === "CelesTrak")) {
    anomalyCounts.missingCelestrakSource += 1;
  }
}

console.log("\nQuality anomalies\n");
console.table(Object.entries(anomalyCounts).map(([check, count]) => ({ check, count })));

const missingStructuredMetadata = rows.filter((row) =>
  [row.operator, row.manufacturer, row.country, row.launch_date, row.mission_category]
    .some(missing),
);
console.log("\nRows with missing structured metadata\n");
console.table(missingStructuredMetadata.map((row) => ({
  noradId: row.norad_id,
  name: row.name,
  missing: [
    ["operator", row.operator],
    ["manufacturer", row.manufacturer],
    ["country", row.country],
    ["launch_date", row.launch_date],
    ["mission_category", row.mission_category],
  ].filter(([, value]) => missing(value)).map(([field]) => field).join(", "),
})));

const staleRows = rows
  .map((row) => ({
    noradId: row.norad_id,
    name: row.name,
    epoch: row.source_updated_at,
    ageDays: (now - new Date(row.source_updated_at).getTime()) / 86_400_000,
  }))
  .filter((row) => row.ageDays > 3.5)
  .sort((left, right) => right.ageDays - left.ageDays);
console.log("\nTen oldest orbital epochs\n");
console.table(staleRows.slice(0, 10).map((row) => ({
  ...row,
  ageDays: row.ageDays.toFixed(1),
})));
