import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { createClient } from "@supabase/supabase-js";

if (existsSync(".env.local")) {
  loadEnvFile(".env.local");
}

const url =
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error(
    "SUPABASE_URL and a service-role key (or their public equivalents) are required.",
  );
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const schemaProbe = await supabase
  .from("satellites")
  .select("norad_id,orbital_elements")
  .limit(1);

if (schemaProbe.error) {
  console.error(
    `Catalog schema is not ready: ${schemaProbe.error.message} (${schemaProbe.error.code}).`,
  );
  console.error(
    "Apply supabase/migrations/20260728000000_expand_satellite_catalog.sql first.",
  );
  process.exitCode = 1;
} else {
  const [
    operationalResult,
    orbitalResult,
    latestResult,
    stagingResult,
  ] = await Promise.all([
    supabase
      .from("satellites")
      .select("norad_id", { count: "exact", head: true })
      .eq("status", "operational"),
    supabase
      .from("satellites")
      .select("norad_id", { count: "exact", head: true })
      .eq("status", "operational")
      .not("orbital_elements", "is", null),
    supabase
      .from("satellites")
      .select("synced_at")
      .eq("status", "operational")
      .order("synced_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("satellite_catalog_staging")
      .select("norad_id", { count: "exact", head: true }),
  ]);

  const error =
    operationalResult.error ??
    orbitalResult.error ??
    latestResult.error ??
    stagingResult.error;
  if (error) {
    throw error;
  }

  const operational = operationalResult.count ?? 0;
  const withOrbitalElements = orbitalResult.count ?? 0;
  const stagedRows = stagingResult.count ?? 0;
  const ready =
    operational > 1 &&
    operational === withOrbitalElements &&
    stagedRows === 0 &&
    Boolean(latestResult.data?.synced_at);

  console.table([
    { metric: "Operational satellites", value: operational },
    { metric: "With OMM orbital elements", value: withOrbitalElements },
    {
      metric: "Latest catalog sync",
      value: latestResult.data?.synced_at ?? "none",
    },
    { metric: "Unpublished staging rows", value: stagedRows },
    { metric: "NORAD uniqueness", value: "database primary key" },
    { metric: "Catalog ready", value: ready ? "yes" : "no" },
  ]);

  if (!ready) {
    console.error(
      "Run the Trigger.dev tasks sync-gcat-metadata and then sync-satellite-catalog, then repeat this check.",
    );
    process.exitCode = 1;
  }
}
