import { createClient } from "@supabase/supabase-js";
import { logger, schedules } from "@trigger.dev/sdk";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";

import { buildGcatMetadata } from "@/lib/gcat-metadata";
import {
  buildSatelliteCatalog,
  type ExistingCatalogRecord,
} from "@/lib/satellite-catalog";
import {
  celestrakSnapshotAgeMs,
  parseCelestrakSnapshot,
  serializeCelestrakSnapshot,
} from "@/lib/source-snapshot";

const CELESTRAK_ACTIVE_JSON_URL =
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=JSON";
const SATNOGS_CATALOG_URL =
  "https://db.satnogs.org/api/satellites/?format=json";
const GCAT_OBJECT_CATALOG_URL =
  "https://planet4589.org/space/gcat/tsv/cat/satcat.tsv";
const GCAT_EXTENDED_OBJECT_CATALOG_URL =
  "https://planet4589.org/space/gcat/tsv/cat/satcat100k.tsv";
const GCAT_PAYLOAD_CATALOG_URL =
  "https://planet4589.org/space/gcat/tsv/cat/psatcat.tsv";
const GCAT_EXTENDED_PAYLOAD_CATALOG_URL =
  "https://planet4589.org/space/gcat/tsv/cat/psatcat100k.tsv";
const GCAT_ORGANIZATIONS_URL =
  "https://planet4589.org/space/gcat/tsv/tables/orgs.tsv";
const GCAT_CURRENT_CATALOG_URL =
  "https://planet4589.org/space/gcat/tsv/derived/currentcat.tsv";
const UPSERT_BATCH_SIZE = 200;
const SELECT_PAGE_SIZE = 1_000;
const CELESTRAK_SNAPSHOT_PATH = "catalog/celestrak-active.snapshot.json";
const SOURCE_FETCH_TIMEOUT_MS = 30_000;

const orbitalElementsSchema = z.object({
  OBJECT_NAME: z.string(),
  OBJECT_ID: z.string(),
  EPOCH: z.string(),
  MEAN_MOTION: z.number().positive(),
  ECCENTRICITY: z.number(),
  INCLINATION: z.number(),
  RA_OF_ASC_NODE: z.number(),
  ARG_OF_PERICENTER: z.number(),
  MEAN_ANOMALY: z.number(),
  NORAD_CAT_ID: z.number(),
  ELEMENT_SET_NO: z.number(),
  BSTAR: z.number(),
  MEAN_MOTION_DOT: z.number(),
  MEAN_MOTION_DDOT: z.number(),
});

const satnogsSatelliteSchema = z.object({
  sat_id: z.string(),
  norad_cat_id: z.number().nullable(),
  norad_follow_id: z.number().nullable(),
  name: z.string(),
  names: z.string().nullable(),
  status: z.string(),
  launched: z.string().nullable(),
  countries: z.string().nullable(),
  operator: z.string().nullable(),
  website: z.string().nullable(),
  updated: z.string(),
});

const celestrakCatalogSchema = z.array(orbitalElementsSchema);
const satnogsCatalogSchema = z.array(satnogsSatelliteSchema);

const gcatSatelliteMetadataRecordSchema = z.object({
  jcat: z.string(),
  plName: z.string().nullable(),
  altNames: z.string().nullable(),
  operator: z.string().nullable(),
  manufacturer: z.string().nullable(),
  country: z.string().nullable(),
  launchDate: z.string().nullable(),
  missionCategory: z.string().nullable(),
});
const gcatSatelliteMetadataSchema = z.array(gcatSatelliteMetadataRecordSchema);
const gcatSatelliteSnapshotSchema = z.union([
  z.object({
    fetchedAt: z.string().datetime(),
    records: gcatSatelliteMetadataSchema,
  }),
  gcatSatelliteMetadataSchema.transform((records) => ({
    fetchedAt: null,
    records,
  })),
]);

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured in Trigger.dev.",
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function fetchText(url: string) {
  const response = await fetch(url, {
    headers: { "User-Agent": "COOPER/0.1" },
    signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.text();
}

function parseOptionalJson<T extends z.ZodType>(
  text: string | null,
  schema: T,
  sourceName: string,
): z.output<T> | undefined {
  if (!text) return undefined;
  try {
    return schema.parse(JSON.parse(text));
  } catch (error) {
    logger.warn(`${sourceName} enrichment is invalid; continuing without it.`, {
      error,
    });
    return undefined;
  }
}

async function loadExistingSatelliteFields(
  supabase: ReturnType<typeof getSupabaseAdmin>,
) {
  const records: ExistingCatalogRecord[] = [];

  for (let from = 0; ; from += SELECT_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("satellites")
      .select(
        "norad_id, satnogs_id, alternate_name, operator, operator_source, operator_description, manufacturer, country, launch_date, mission_category, mission_description, data_center_relation, source_urls, mission_enriched_at, operator_enriched_at, gcat_verified_at, satnogs_verified_at",
      )
      .order("norad_id", { ascending: true })
      .range(from, from + SELECT_PAGE_SIZE - 1);

    if (error) throw error;
    for (const record of data ?? []) {
      records.push(record);
    }
    if ((data?.length ?? 0) < SELECT_PAGE_SIZE) {
      break;
    }
  }

  return records;
}

async function loadOperationalCount(
  supabase: ReturnType<typeof getSupabaseAdmin>,
) {
  const { count, error } = await supabase
    .from("satellites")
    .select("norad_id", { count: "exact", head: true })
    .eq("status", "operational");
  if (error) throw error;
  return count ?? 0;
}

async function saveSnapshot(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  path: string,
  body: string,
  contentType = "application/json",
) {
  const { error } = await supabase.storage
    .from("source-snapshots")
    .upload(path, body, {
      contentType,
      upsert: true,
    });

  if (error) throw error;
  return path;
}

async function loadSnapshot(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  path: string,
) {
  const { data, error } = await supabase.storage
    .from("source-snapshots")
    .download(path);

  if (error) throw error;
  return data.text();
}

async function saveCelestrakSnapshot(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  body: string,
  fetchedAt: string,
) {
  return saveSnapshot(
    supabase,
    CELESTRAK_SNAPSHOT_PATH,
    serializeCelestrakSnapshot({ body, fetchedAt }),
  );
}

async function loadFreshCelestrakSnapshot(
  supabase: ReturnType<typeof getSupabaseAdmin>,
) {
  const snapshot = parseCelestrakSnapshot(
    await loadSnapshot(supabase, CELESTRAK_SNAPSHOT_PATH),
  );
  const ageMs = celestrakSnapshotAgeMs(snapshot.fetchedAt);
  return { ...snapshot, ageMs };
}

async function saveCompressedSnapshot(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  path: string,
  body: string,
) {
  const { error } = await supabase.storage
    .from("source-snapshots")
    .upload(path, gzipSync(body), {
      contentType: "application/gzip",
      upsert: true,
    });

  if (error) throw error;
  return path;
}

async function loadCompressedSnapshot(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  path: string,
) {
  const { data, error } = await supabase.storage
    .from("source-snapshots")
    .download(path);

  if (error) {
    throw new Error(
      `GCAT snapshot ${path} is unavailable. Run sync-gcat-metadata before sync-satellite-catalog.`,
      { cause: error },
    );
  }

  return gunzipSync(Buffer.from(await data.arrayBuffer())).toString("utf8");
}

export const syncGcatMetadata = schedules.task({
  id: "sync-gcat-metadata",
  cron: "0 2 * * *",
  retry: { maxAttempts: 3 },
  run: async () => {
    const supabase = getSupabaseAdmin();
    const [
      gcatObjectText,
      gcatExtendedObjectText,
      gcatPayloadText,
      gcatExtendedPayloadText,
      gcatOrganizationsText,
      gcatCurrentCatalogText,
    ] = await Promise.all([
      fetchText(GCAT_OBJECT_CATALOG_URL),
      fetchText(GCAT_EXTENDED_OBJECT_CATALOG_URL),
      fetchText(GCAT_PAYLOAD_CATALOG_URL),
      fetchText(GCAT_EXTENDED_PAYLOAD_CATALOG_URL),
      fetchText(GCAT_ORGANIZATIONS_URL),
      fetchText(GCAT_CURRENT_CATALOG_URL),
    ]);

    const metadata = buildGcatMetadata({
      objects: gcatObjectText,
      extendedObjects: gcatExtendedObjectText,
      payloads: gcatPayloadText,
      extendedPayloads: gcatExtendedPayloadText,
      organizations: gcatOrganizationsText,
      currentCatalog: gcatCurrentCatalogText,
    });
    const fetchedAt = new Date().toISOString();

    const snapshotPaths = await Promise.all([
      saveCompressedSnapshot(
        supabase,
        "catalog/gcat-satcat.tsv.gz",
        gcatObjectText,
      ),
      saveCompressedSnapshot(
        supabase,
        "catalog/gcat-satcat100k.tsv.gz",
        gcatExtendedObjectText,
      ),
      saveCompressedSnapshot(
        supabase,
        "catalog/gcat-psatcat.tsv.gz",
        gcatPayloadText,
      ),
      saveCompressedSnapshot(
        supabase,
        "catalog/gcat-psatcat100k.tsv.gz",
        gcatExtendedPayloadText,
      ),
      saveCompressedSnapshot(
        supabase,
        "catalog/gcat-organizations.tsv.gz",
        gcatOrganizationsText,
      ),
      saveCompressedSnapshot(
        supabase,
        "catalog/gcat-currentcat.tsv.gz",
        gcatCurrentCatalogText,
      ),
      saveCompressedSnapshot(
        supabase,
        "catalog/gcat-satellite-metadata.json.gz",
        JSON.stringify({ fetchedAt, records: metadata }),
      ),
    ]);

    logger.info("GCAT metadata snapshots synchronized", {
      metadataRecords: metadata.length,
      snapshotPaths,
    });
    return { metadataRecords: metadata.length, snapshotPaths };
  },
});

export const syncSatelliteCatalog = schedules.task({
  id: "sync-satellite-catalog",
  cron: "0 3,11,19 * * *",
  retry: { maxAttempts: 3 },
  run: async () => {
    const supabase = getSupabaseAdmin();
    let celestrakSource: {
      body: string;
      fetchedAt: string;
      usedFallback: boolean;
      fallbackAgeMs: number | null;
    };
    try {
      celestrakSource = {
        body: await fetchText(CELESTRAK_ACTIVE_JSON_URL),
        fetchedAt: new Date().toISOString(),
        usedFallback: false,
        fallbackAgeMs: null,
      };
    } catch (error) {
      logger.warn(
        "CelesTrak did not provide a newer active catalog; checking the last valid snapshot.",
        { error },
      );
      const snapshot = await loadFreshCelestrakSnapshot(supabase);
      celestrakSource = {
        body: snapshot.body,
        fetchedAt: snapshot.fetchedAt,
        usedFallback: true,
        fallbackAgeMs: snapshot.ageMs,
      };
    }

    const [
      satnogsJsonText,
      gcatMetadataText,
      existingSatelliteFields,
      previousOperationalCount,
    ] = await Promise.all([
      fetchText(SATNOGS_CATALOG_URL).catch((error) => {
        logger.warn("SatNOGS enrichment is unavailable; continuing without it.", {
          error,
        });
        return null;
      }),
      loadCompressedSnapshot(
        supabase,
        "catalog/gcat-satellite-metadata.json.gz",
      ).catch((error) => {
        logger.warn("GCAT enrichment is unavailable; continuing without it.", {
          error,
        });
        return null;
      }),
      loadExistingSatelliteFields(supabase),
      loadOperationalCount(supabase),
    ]);
    const satnogsCatalog = parseOptionalJson(
      satnogsJsonText,
      satnogsCatalogSchema,
      "SatNOGS",
    );
    const gcatSnapshot = parseOptionalJson(
      gcatMetadataText,
      gcatSatelliteSnapshotSchema,
      "GCAT",
    );
    const syncedAt = new Date().toISOString();
    const buildCatalog = (body: string) =>
      buildSatelliteCatalog({
        celestrak: celestrakCatalogSchema.parse(JSON.parse(body)),
        satnogs: satnogsCatalog,
        gcat: gcatSnapshot?.records,
        gcatVerifiedAt: gcatSnapshot?.fetchedAt,
        existing: existingSatelliteFields,
        syncedAt,
        previousOperationalCount,
      });
    let builtCatalog;
    try {
      builtCatalog = buildCatalog(celestrakSource.body);
    } catch (error) {
      if (celestrakSource.usedFallback) throw error;
      logger.warn(
        "The live CelesTrak catalog failed validation; checking the last valid snapshot.",
        { error },
      );
      const snapshot = await loadFreshCelestrakSnapshot(supabase);
      celestrakSource = {
        body: snapshot.body,
        fetchedAt: snapshot.fetchedAt,
        usedFallback: true,
        fallbackAgeMs: snapshot.ageMs,
      };
      builtCatalog = buildCatalog(celestrakSource.body);
    }
    const {
      rows: rowsToUpsert,
      satnogsReassignments,
      metrics,
    } = builtCatalog;

    const snapshotPaths = [
      ...(celestrakSource.usedFallback
        ? []
        : [
            await saveCelestrakSnapshot(
              supabase,
              celestrakSource.body,
              celestrakSource.fetchedAt,
            ),
          ]),
      ...(satnogsJsonText && satnogsCatalog
        ? [await saveSnapshot(supabase, "catalog/satnogs.json", satnogsJsonText)]
        : []),
    ];
    const syncId = crypto.randomUUID();
    const { error: cleanupError } = await supabase
      .from("satellite_catalog_staging")
      .delete()
      .lt("created_at", new Date(Date.now() - 2 * 86_400_000).toISOString());
    if (cleanupError) {
      logger.warn("Old satellite catalog staging rows could not be removed.", {
        error: cleanupError,
      });
    }

    for (
      let index = 0;
      index < rowsToUpsert.length;
      index += UPSERT_BATCH_SIZE
    ) {
      const { error } = await supabase
        .from("satellite_catalog_staging")
        .upsert(
          rowsToUpsert.slice(index, index + UPSERT_BATCH_SIZE).map((row) => ({
            sync_id: syncId,
            norad_id: row.norad_id,
            payload: row,
          })),
          {
            onConflict: "sync_id,norad_id",
          },
        );
      if (error) throw error;
    }

    const { data: publishedRows, error: publishError } = await supabase.rpc(
      "publish_satellite_catalog",
      {
        p_sync_id: syncId,
        p_synced_at: syncedAt,
      },
    );
    if (publishError) throw publishError;
    if (publishedRows !== rowsToUpsert.length) {
      throw new Error(
        `Published ${publishedRows} rows after staging ${rowsToUpsert.length}.`,
      );
    }

    logger.info("Satellite catalog synchronized", {
      ...metrics,
      satnogsReassignments: satnogsReassignments.length,
      celestrakFetchedAt: celestrakSource.fetchedAt,
      usedCelestrakFallback: celestrakSource.usedFallback,
      celestrakFallbackAgeMs: celestrakSource.fallbackAgeMs,
      snapshotPaths,
    });

    return {
      ...metrics,
      satnogsReassignments: satnogsReassignments.length,
      celestrakFetchedAt: celestrakSource.fetchedAt,
      usedCelestrakFallback: celestrakSource.usedFallback,
      celestrakFallbackAgeMs: celestrakSource.fallbackAgeMs,
      snapshotPaths,
    };
  },
});
