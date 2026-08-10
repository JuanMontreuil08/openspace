import { createClient } from "@supabase/supabase-js";
import { starcloudFallback } from "./starcloud";
import type {
  OrbitalElements,
  SatelliteIndexEntry,
  SatelliteRecord,
  SourceLink,
} from "./types";

type SatelliteRow = {
  norad_id: number;
  satnogs_id: string | null;
  cospar_id: string | null;
  name: string;
  alternate_name: string | null;
  operator: string | null;
  operator_description: string | null;
  manufacturer: string | null;
  country: string | null;
  launch_date: string | null;
  status: SatelliteRecord["status"];
  mission_category: string | null;
  mission_description: string | null;
  data_center_relation: string | null;
  inclination_deg: number;
  period_minutes: number;
  orbital_elements: OrbitalElements | null;
  tle_line_1: string | null;
  tle_line_2: string | null;
  source_urls: SourceLink[];
  mission_enriched_at: string | null;
  operator_enriched_at: string | null;
  source_updated_at: string;
};

const PAGE_SIZE = 1_000;
const DEFAULT_NORAD_ID = 66303;
const SATELLITE_DETAIL_COLUMNS =
  "norad_id, satnogs_id, cospar_id, name, alternate_name, operator, operator_description, manufacturer, country, launch_date, status, mission_category, mission_description, data_center_relation, inclination_deg, period_minutes, orbital_elements, tle_line_1, tle_line_2, source_urls, mission_enriched_at, operator_enriched_at, source_updated_at";

function mapRow(row: SatelliteRow): SatelliteRecord {
  return {
    noradId: row.norad_id,
    satnogsId: row.satnogs_id,
    cosparId: row.cospar_id,
    name: row.name,
    alternateName: row.alternate_name,
    operator: row.operator,
    operatorDescription: row.operator_description,
    manufacturer: row.manufacturer,
    country: row.country,
    launchDate: row.launch_date,
    status: row.status,
    missionCategory: row.mission_category,
    missionDescription: row.mission_description,
    dataCenterRelation: row.data_center_relation,
    inclinationDeg: row.inclination_deg,
    periodMinutes: row.period_minutes,
    orbitalElements: row.orbital_elements,
    tleLine1: row.tle_line_1,
    tleLine2: row.tle_line_2,
    sources: row.source_urls,
    missionEnrichedAt: row.mission_enriched_at,
    operatorEnrichedAt: row.operator_enriched_at,
    updatedAt: row.source_updated_at,
  };
}

function createPublicClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function getSatelliteByNorad(
  noradId: number,
): Promise<SatelliteRecord | null> {
  const supabase = createPublicClient();
  if (!supabase) {
    return noradId === starcloudFallback.noradId ? starcloudFallback : null;
  }

  const { data, error } = await supabase
    .from("satellites")
    .select(SATELLITE_DETAIL_COLUMNS)
    .eq("norad_id", noradId)
    .eq("status", "operational")
    .maybeSingle();
  if (error) throw error;
  return data ? mapRow(data as SatelliteRow) : null;
}

export async function getSatelliteExplorerData(): Promise<{
  catalog: SatelliteIndexEntry[];
  initialSatellite: SatelliteRecord;
  dataMode: "live" | "demo";
}> {
  const supabase = createPublicClient();
  if (!supabase) {
    return {
      catalog: [starcloudFallback],
      initialSatellite: starcloudFallback,
      dataMode: "demo",
    };
  }

  try {
    const catalog: SatelliteIndexEntry[] = [];

    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("satellites")
        .select("norad_id, name, alternate_name, operator, country")
        .eq("status", "operational")
        .order("name")
        .order("norad_id")
        .range(from, from + PAGE_SIZE - 1);

      if (error) {
        throw error;
      }

      const page = data ?? [];
      catalog.push(
        ...page.map((row) => ({
          noradId: row.norad_id,
          name: row.name,
          alternateName: row.alternate_name,
          operator: row.operator,
          country: row.country,
        })),
      );
      if (page.length < PAGE_SIZE) {
        break;
      }
    }

    if (catalog.length === 0) {
      return {
        catalog: [starcloudFallback],
        initialSatellite: starcloudFallback,
        dataMode: "demo",
      };
    }

    const initialNoradId = catalog.some(
      (satellite) => satellite.noradId === DEFAULT_NORAD_ID,
    )
      ? DEFAULT_NORAD_ID
      : catalog[0].noradId;
    const initialSatellite = await getSatelliteByNorad(initialNoradId);
    if (!initialSatellite) throw new Error("Initial satellite is unavailable.");

    return {
      catalog,
      initialSatellite,
      dataMode: "live",
    };
  } catch {
    return {
      catalog: [starcloudFallback],
      initialSatellite: starcloudFallback,
      dataMode: "demo",
    };
  }
}
