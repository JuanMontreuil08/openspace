import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";
import { logger, schedules, task } from "@trigger.dev/sdk";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";

import {
  reconcileSatelliteIdentities,
  type SatelliteIdentity,
} from "@/lib/satellite-identity";

const NORAD_ID = 66303;
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
const GCAT_SOURCE_URL = "https://planet4589.org/space/gcat/";
const SATNOGS_PAGE_URL =
  "https://db.satnogs.org/satellite/MEKC-1774-6115-5644-8771/";
const STARCLOUD_OPERATOR_URL = "https://www.starcloud.com/";
const UPSERT_BATCH_SIZE = 200;
const SELECT_PAGE_SIZE = 1_000;

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

type ExistingSatelliteFields = SatelliteIdentity & {
  operator: string | null;
  operator_description: string | null;
  manufacturer: string | null;
  function: string | null;
  data_center_relation: string | null;
};

type GcatObject = {
  JCAT: string;
  Type: string;
  PLName: string;
  LDate: string;
  Owner: string;
  State: string;
  Manufacturer: string;
  AltNames: string;
};

type GcatPayload = {
  JCAT: string;
  Category: string;
};

type GcatOrganization = {
  Code: string;
  StateCode: string;
  Class: string;
  ShortName: string;
  Name: string;
  Location: string;
  ShortEName: string;
  EName: string;
  UName: string;
};

const gcatSatelliteMetadataSchema = z.array(
  z.object({
    jcat: z.string(),
    plName: z.string().nullable(),
    altNames: z.string().nullable(),
    operator: z.string(),
    operatorDescription: z.string(),
    manufacturer: z.string().nullable(),
    country: z.string().nullable(),
    launchDate: z.string(),
    function: z.string(),
  }),
);

type GcatSatelliteMetadata = z.infer<
  typeof gcatSatelliteMetadataSchema
>[number];

const GCAT_CATEGORY_DESCRIPTIONS: Record<string, string> = {
  AST: "astronomy observations",
  BIO: "biology and life-science research",
  CAL: "calibration for atmospheric or space-surveillance measurements",
  COM: "communications and connectivity",
  EDU: "education and training",
  EOSCI: "Earth-observation science",
  EW: "missile early warning and tracking",
  GEOD: "geodesy",
  IMG: "optical Earth imaging",
  "IMG-R": "radar imaging",
  INF: "in-orbit infrastructure and support",
  MET: "meteorological observation",
  "MET-RO": "radio-occultation meteorology",
  MGRAV: "microgravity experiments",
  MISC: "a miscellaneous specialist mission",
  NAV: "navigation, positioning, and timing",
  PLAN: "deep-space exploration",
  SCI: "scientific research",
  SIG: "signals intelligence",
  SS: "human spaceflight or cargo support",
  TARG: "target and tracking tests",
  TECH: "technology demonstration and training",
  WEAPON: "a defense weapons experiment",
};

const GCAT_ORGANIZATION_CLASSES: Record<string, string> = {
  A: "academic, amateur, or nonprofit",
  B: "commercial",
  C: "civil-government",
  D: "defense, military, or intelligence",
};

function parseTsv<T>(text: string, requiredColumns: string[]) {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.startsWith("#"));
  if (headerIndex === -1) {
    throw new Error("GCAT TSV header was not found.");
  }

  const headers = lines[headerIndex].slice(1).split("\t");
  for (const column of requiredColumns) {
    if (!headers.includes(column)) {
      throw new Error(`GCAT TSV column ${column} was not found.`);
    }
  }

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
      ) as T;
    });
}

function usefulGcatValue(value: string | undefined) {
  if (!value || value === "-" || value === "?") {
    return null;
  }
  return value;
}

function gcatIdForNorad(noradId: number) {
  return `S${String(noradId).padStart(5, "0")}`;
}

function organizationName(organization: GcatOrganization) {
  return (
    usefulGcatValue(organization.EName) ??
    usefulGcatValue(organization.Name) ??
    usefulGcatValue(organization.ShortEName) ??
    usefulGcatValue(organization.ShortName) ??
    organization.Code
  );
}

function resolveOrganizations(
  value: string | undefined,
  organizationsByCode: Map<string, GcatOrganization>,
) {
  const codes = usefulGcatValue(value)?.split("/") ?? [];
  return codes
    .map((code) => organizationsByCode.get(code.replace(/\?$/, "")))
    .filter((organization): organization is GcatOrganization =>
      Boolean(organization),
    );
}

function joinOrganizationNames(organizations: GcatOrganization[]) {
  if (organizations.length === 0) return null;
  return organizations.map(organizationName).join(" and ");
}

function describeOperator(organizations: GcatOrganization[]) {
  if (organizations.length === 0) return null;

  const names = joinOrganizationNames(organizations);
  const classifications = [
    ...new Set(
      organizations
        .map((organization) => GCAT_ORGANIZATION_CLASSES[organization.Class])
        .filter(Boolean),
    ),
  ];
  const locations = [
    ...new Set(
      organizations
        .map((organization) => usefulGcatValue(organization.Location))
        .filter((location): location is string => Boolean(location)),
    ),
  ];
  const ownerLabel =
    organizations.length === 1 ? "owner/operator" : "joint owners/operators";
  const classificationText =
    classifications.length > 0
      ? ` GCAT classifies ${organizations.length === 1 ? "it" : "them"} as ${classifications.join(" and ")}.`
      : "";
  const locationText =
    locations.length > 0
      ? ` The recorded location is ${locations.join(" and ")}.`
      : "";

  return `GCAT records ${names} as the ${ownerLabel} of this satellite.${classificationText}${locationText}`;
}

function describeFunction(category: string | undefined) {
  const categories =
    usefulGcatValue(category)
      ?.replaceAll("?", "")
      .replaceAll("*", "")
      .split("/")
      .map((value) => GCAT_CATEGORY_DESCRIPTIONS[value])
      .filter(Boolean) ?? [];

  if (categories.length === 0) return null;
  const description =
    categories.length === 1
      ? categories[0]
      : `${categories.slice(0, -1).join(", ")} and ${categories.at(-1)}`;
  return `Its catalogued mission function is ${description}.`;
}

function parseGcatLaunchDate(value: string | undefined) {
  const match = usefulGcatValue(value)?.match(
    /^(\d{4}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})/,
  );
  if (!match) return null;

  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].indexOf(match[2]);
  return new Date(
    Date.UTC(Number(match[1]), month, Number(match[3])),
  ).toISOString();
}

function alternateName(
  primaryName: string,
  satnogsNames: string | null,
  metadata: GcatSatelliteMetadata,
) {
  const normalizedPrimaryName = primaryName.toLocaleLowerCase();
  return (
    [
      usefulValue(satnogsNames),
      metadata.plName,
      metadata.altNames,
    ].find((value) => value?.toLocaleLowerCase() !== normalizedPrimaryName) ??
    ""
  );
}

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
    headers: { "User-Agent": "OpenSpace MVP/0.1" },
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.text();
}

function extractSatnogsDescription(html: string) {
  const match = html.match(
    /<!-- Satellite Description -->[\s\S]*?<p>([\s\S]*?)<\/p>/i,
  );
  if (!match?.[1]) {
    throw new Error("SatNOGS mission description was not found.");
  }

  return match[1]
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractReadableText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20_000);
}

function canonicalNoradId(
  satellite: z.infer<typeof satnogsSatelliteSchema>,
) {
  return satellite.norad_follow_id ?? satellite.norad_cat_id;
}

function usefulValue(value: string | null) {
  if (!value || value === "None" || value === "Unknown") {
    return null;
  }
  return value;
}

function celestrakObjectUrl(noradId: number) {
  return `https://celestrak.org/NORAD/elements/gp.php?CATNR=${noradId}&FORMAT=JSON`;
}

function sourceUpdatedAt(epoch: string) {
  return new Date(epoch.endsWith("Z") ? epoch : `${epoch}Z`).toISOString();
}

async function loadExistingSatelliteFields(
  supabase: ReturnType<typeof getSupabaseAdmin>,
) {
  const records: ExistingSatelliteFields[] = [];

  for (let from = 0; ; from += SELECT_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("satellites")
      .select(
        "norad_id, satnogs_id, operator, operator_description, manufacturer, function, data_center_relation",
      )
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
    ] = await Promise.all([
      fetchText(GCAT_OBJECT_CATALOG_URL),
      fetchText(GCAT_EXTENDED_OBJECT_CATALOG_URL),
      fetchText(GCAT_PAYLOAD_CATALOG_URL),
      fetchText(GCAT_EXTENDED_PAYLOAD_CATALOG_URL),
      fetchText(GCAT_ORGANIZATIONS_URL),
    ]);

    const gcatObjects = [
      ...parseTsv<GcatObject>(gcatObjectText, [
        "JCAT",
        "Type",
        "PLName",
        "LDate",
        "Owner",
        "State",
        "Manufacturer",
        "AltNames",
      ]),
      ...parseTsv<GcatObject>(gcatExtendedObjectText, [
        "JCAT",
        "Type",
        "PLName",
        "LDate",
        "Owner",
        "State",
        "Manufacturer",
        "AltNames",
      ]),
    ];
    const gcatPayloadsById = new Map(
      [
        ...parseTsv<GcatPayload>(gcatPayloadText, ["JCAT", "Category"]),
        ...parseTsv<GcatPayload>(gcatExtendedPayloadText, [
          "JCAT",
          "Category",
        ]),
      ].map((payload) => [payload.JCAT, payload]),
    );
    const gcatOrganizationsByCode = new Map(
      parseTsv<GcatOrganization>(gcatOrganizationsText, [
        "Code",
        "StateCode",
        "Class",
        "ShortName",
        "Name",
        "Location",
        "ShortEName",
        "EName",
        "UName",
      ]).map((organization) => [organization.Code, organization]),
    );
    const metadata = gcatObjects.flatMap((object) => {
      const payload = gcatPayloadsById.get(object.JCAT);
      const operators = resolveOrganizations(
        object.Owner,
        gcatOrganizationsByCode,
      );
      const countries = resolveOrganizations(
        object.State,
        gcatOrganizationsByCode,
      );
      const manufacturers = resolveOrganizations(
        object.Manufacturer,
        gcatOrganizationsByCode,
      );
      const launchDate = parseGcatLaunchDate(object.LDate);
      const functionDescription = describeFunction(payload?.Category);
      const operator = joinOrganizationNames(operators);
      const operatorDescription = describeOperator(operators);

      if (
        !object.Type.trim().startsWith("P") ||
        !launchDate ||
        !functionDescription ||
        !operator ||
        !operatorDescription
      ) {
        return [];
      }

      return [
        {
          jcat: object.JCAT,
          plName: usefulGcatValue(object.PLName),
          altNames: usefulGcatValue(object.AltNames),
          operator,
          operatorDescription,
          manufacturer: joinOrganizationNames(manufacturers),
          country: joinOrganizationNames(countries),
          launchDate,
          function: functionDescription,
        },
      ];
    });

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
        "catalog/gcat-satellite-metadata.json.gz",
        JSON.stringify(metadata),
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
    const celestrakPromise = fetchText(CELESTRAK_ACTIVE_JSON_URL).catch(
      async (error) => {
        logger.warn(
          "CelesTrak did not provide a newer active catalog; using the last valid snapshot.",
          { error },
        );
        return loadSnapshot(supabase, "catalog/celestrak-active.json");
      },
    );
    const [
      celestrakJsonText,
      satnogsJsonText,
      gcatMetadataText,
      existingSatelliteFields,
    ] = await Promise.all([
      celestrakPromise,
      fetchText(SATNOGS_CATALOG_URL),
      loadCompressedSnapshot(
        supabase,
        "catalog/gcat-satellite-metadata.json.gz",
      ),
      loadExistingSatelliteFields(supabase),
    ]);
    const celestrakCatalog = celestrakCatalogSchema.parse(
      JSON.parse(celestrakJsonText),
    );
    const satnogsCatalog = satnogsCatalogSchema.parse(
      JSON.parse(satnogsJsonText),
    );
    const gcatMetadata = gcatSatelliteMetadataSchema.parse(
      JSON.parse(gcatMetadataText),
    );
    const gcatMetadataById = new Map(
      gcatMetadata.map((metadata) => [metadata.jcat, metadata]),
    );
    const existingByNoradId = new Map(
      existingSatelliteFields.map((satellite) => [
        satellite.norad_id,
        satellite,
      ]),
    );
    const existingBySatnogsId = new Map(
      existingSatelliteFields.map((satellite) => [
        satellite.satnogs_id,
        satellite,
      ]),
    );
    const celestrakByNorad = new Map(
      celestrakCatalog.map((satellite) => [
        satellite.NORAD_CAT_ID,
        satellite,
      ]),
    );
    const operationalSatellites = satnogsCatalog.filter(
      (satellite) => satellite.status === "alive",
    );
    const satellitesByNorad = Map.groupBy(
      operationalSatellites.filter(
        (satellite) => canonicalNoradId(satellite) !== null,
      ),
      (satellite) => canonicalNoradId(satellite) as number,
    );
    const matchedSatellites = operationalSatellites.filter((satellite) => {
      const noradId = canonicalNoradId(satellite);
      return noradId !== null && celestrakByNorad.has(noradId);
    });
    const usableSatellites = matchedSatellites.filter((satellite) => {
      const noradId = canonicalNoradId(satellite);
      return noradId !== null && satellitesByNorad.get(noradId)?.length === 1;
    });
    const catalogSatellites = usableSatellites.filter((satellite) => {
      const noradId = canonicalNoradId(satellite) as number;
      return gcatMetadataById.has(gcatIdForNorad(noradId));
    });
    const syncedAt = new Date().toISOString();
    const rows = catalogSatellites.map((satellite) => {
      const noradId = canonicalNoradId(satellite) as number;
      const orbitalElements = celestrakByNorad.get(noradId);
      if (!orbitalElements) {
        throw new Error(`CelesTrak record ${noradId} disappeared during join.`);
      }

      const gcatId = gcatIdForNorad(noradId);
      const gcat = gcatMetadataById.get(gcatId);
      if (!gcat) {
        throw new Error(`GCAT record ${gcatId} disappeared during join.`);
      }
      const existing =
        existingBySatnogsId.get(satellite.sat_id) ??
        existingByNoradId.get(noradId);
      const sources = [
        { label: "CelesTrak", url: celestrakObjectUrl(noradId) },
        {
          label: "SatNOGS DB",
          url: `https://db.satnogs.org/satellite/${satellite.sat_id}/`,
        },
        { label: "GCAT", url: GCAT_SOURCE_URL },
      ];
      if (usefulValue(satellite.website)) {
        sources.push({
          label: "Mission website",
          url: satellite.website as string,
        });
      }

      return {
        norad_id: noradId,
        satnogs_id: satellite.sat_id,
        cospar_id: orbitalElements.OBJECT_ID,
        name: satellite.name || orbitalElements.OBJECT_NAME,
        alternate_name: alternateName(
          satellite.name || orbitalElements.OBJECT_NAME,
          satellite.names,
          gcat,
        ),
        operator:
          existing?.operator_description && existing.operator
            ? existing.operator
            : (gcat.operator ?? usefulValue(satellite.operator)),
        operator_description:
          existing?.operator_description ?? gcat.operatorDescription,
        manufacturer: existing?.manufacturer ?? gcat.manufacturer,
        country:
          gcat.country ?? usefulValue(satellite.countries),
        launch_date: satellite.launched ?? gcat.launchDate,
        status: "operational",
        function: existing?.function ?? gcat.function,
        data_center_relation: existing?.data_center_relation ?? null,
        inclination_deg: orbitalElements.INCLINATION,
        period_minutes: 1440 / orbitalElements.MEAN_MOTION,
        orbital_elements: orbitalElements,
        tle_line_1: null,
        tle_line_2: null,
        source_urls: sources,
        source_updated_at: sourceUpdatedAt(orbitalElements.EPOCH),
        synced_at: syncedAt,
      };
    });
    const identityReconciliation = reconcileSatelliteIdentities(
      rows,
      existingSatelliteFields,
    );
    const rowsToUpsert = identityReconciliation.acceptedRows;

    if (identityReconciliation.reassignments.length > 0) {
      logger.info("Satellite NORAD identities reassigned", {
        reassignedNoradRecords: identityReconciliation.reassignments.length,
        reassignments: identityReconciliation.reassignments,
      });
    }
    if (identityReconciliation.conflicts.length > 0) {
      logger.warn("Satellite identity conflicts excluded from synchronization", {
        identityConflicts: identityReconciliation.conflicts.length,
        conflicts: identityReconciliation.conflicts.slice(0, 20),
      });
    }

    const snapshotPaths = await Promise.all([
      saveSnapshot(
        supabase,
        "catalog/celestrak-active.json",
        celestrakJsonText,
      ),
      saveSnapshot(supabase, "catalog/satnogs.json", satnogsJsonText),
    ]);

    for (
      let index = 0;
      index < rowsToUpsert.length;
      index += UPSERT_BATCH_SIZE
    ) {
      const { error } = await supabase
        .from("satellites")
        .upsert(rowsToUpsert.slice(index, index + UPSERT_BATCH_SIZE), {
          onConflict: "satnogs_id",
        });
      if (error) throw error;
    }

    const { error: staleError } = await supabase
      .from("satellites")
      .update({ status: "inactive" })
      .eq("status", "operational")
      .neq("synced_at", syncedAt);
    if (staleError) throw staleError;

    const ambiguousRecords = matchedSatellites.length - usableSatellites.length;
    const excludedByGcat = usableSatellites.length - catalogSatellites.length;
    logger.info("Satellite catalog synchronized", {
      celestrakRecords: celestrakCatalog.length,
      satnogsRecords: satnogsCatalog.length,
      operationalRecords: operationalSatellites.length,
      matchedRecords: matchedSatellites.length,
      ambiguousRecords,
      excludedByGcat,
      identityConflicts: identityReconciliation.conflicts.length,
      reassignedNoradRecords: identityReconciliation.reassignments.length,
      synchronizedRecords: rowsToUpsert.length,
      snapshotPaths,
    });

    return {
      celestrakRecords: celestrakCatalog.length,
      satnogsRecords: satnogsCatalog.length,
      operationalRecords: operationalSatellites.length,
      matchedRecords: matchedSatellites.length,
      ambiguousRecords,
      excludedByGcat,
      identityConflicts: identityReconciliation.conflicts.length,
      reassignedNoradRecords: identityReconciliation.reassignments.length,
      synchronizedRecords: rowsToUpsert.length,
      snapshotPaths,
    };
  },
});

const generatedSummariesSchema = z.object({
  function: z.string().min(80).max(500),
  operatorDescription: z.string().min(80).max(500),
});

export const generateStarcloudSummaries = task({
  id: "generate-starcloud-1-summaries",
  retry: { maxAttempts: 2 },
  run: async () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY must be configured in Trigger.dev.");
    }

    const ai = new GoogleGenAI({ apiKey });
    const [satnogsPage, starcloudPage] = await Promise.all([
      fetchText(SATNOGS_PAGE_URL),
      fetchText(STARCLOUD_OPERATOR_URL),
    ]);
    const satnogsDescription = extractSatnogsDescription(satnogsPage);
    const operatorWebsiteText = extractReadableText(starcloudPage);
    if (!operatorWebsiteText) {
      throw new Error("The Starcloud operator website returned no readable text.");
    }
    const sourceUrls = [SATNOGS_PAGE_URL, STARCLOUD_OPERATOR_URL];

    const structured = await ai.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents: `Create two concise educational summaries in English using only the two source texts below.

Return JSON with exactly these keys: function and operatorDescription.

- function: Summarize what Starcloud-1 was built to demonstrate and does in orbit. Use 2 or 3 sentences, 80–500 characters.
- operatorDescription: Explain what Starcloud does as a company using only the official website text. Use 2 or 3 sentences, 80–500 characters.
- Keep both neutral, factual, understandable to a general audience, and free of promotional language.
- Do not mix company information into the mission summary.
- Do not add facts that are absent from the supplied text.

SatNOGS description:
${satnogsDescription}

Official Starcloud website:
${operatorWebsiteText}`,
      config: {
        responseMimeType: "application/json",
      },
    });

    const candidate = generatedSummariesSchema.parse(
      JSON.parse(structured.text ?? "{}"),
    );
    const supabase = getSupabaseAdmin();
    const raw = JSON.stringify(
      {
        researchedAt: new Date().toISOString(),
        model: "gemini-3.5-flash-lite",
        satnogsDescription,
        operatorWebsiteText,
        candidate,
        sourceUrls,
      },
      null,
      2,
    );
    const snapshotPath = await saveSnapshot(
      supabase,
      "starcloud-1/gemini-summaries.json",
      raw,
    );

    const { error } = await supabase
      .from("satellites")
      .update({
        function: candidate.function,
        operator_description: candidate.operatorDescription,
      })
      .eq("norad_id", NORAD_ID);

    if (error) throw error;

    logger.info("Gemini summaries saved", {
      snapshotPath,
      sourceCount: sourceUrls.length,
    });

    return {
      noradId: NORAD_ID,
      function: candidate.function,
      operatorDescription: candidate.operatorDescription,
      sourceUrls,
      snapshotPath,
    };
  },
});
