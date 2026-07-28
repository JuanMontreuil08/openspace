import { createClient } from "@supabase/supabase-js";
import { starcloudFallback } from "./starcloud";
import type {
  OrbitalElements,
  SatelliteRecord,
  SourceLink,
} from "./types";

type SatelliteRow = {
  norad_id: number;
  satnogs_id: string;
  cospar_id: string;
  name: string;
  alternate_name: string;
  operator: string | null;
  operator_description: string | null;
  manufacturer: string | null;
  country: string | null;
  launch_date: string | null;
  status: SatelliteRecord["status"];
  function: string | null;
  data_center_relation: string | null;
  inclination_deg: number;
  period_minutes: number;
  orbital_elements: OrbitalElements | null;
  tle_line_1: string | null;
  tle_line_2: string | null;
  source_urls: SourceLink[];
  source_updated_at: string;
};

const PAGE_SIZE = 1_000;

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
    function: row.function,
    dataCenterRelation: row.data_center_relation,
    inclinationDeg: row.inclination_deg,
    periodMinutes: row.period_minutes,
    orbitalElements: row.orbital_elements,
    tleLine1: row.tle_line_1,
    tleLine2: row.tle_line_2,
    sources: row.source_urls,
    updatedAt: row.source_updated_at,
  };
}

export async function getSatellites(): Promise<{
  satellites: SatelliteRecord[];
  dataMode: "live" | "demo";
}> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    return { satellites: [starcloudFallback], dataMode: "demo" };
  }

  try {
    const supabase = createClient(url, key, {
      auth: { persistSession: false },
    });
    const rows: SatelliteRow[] = [];

    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("satellites")
        .select("*")
        .eq("status", "operational")
        .order("name")
        .range(from, from + PAGE_SIZE - 1);

      if (error) {
        throw error;
      }

      const page = (data ?? []) as SatelliteRow[];
      rows.push(...page);
      if (page.length < PAGE_SIZE) {
        break;
      }
    }

    if (rows.length === 0) {
      return { satellites: [starcloudFallback], dataMode: "demo" };
    }

    return {
      satellites: rows.map(mapRow),
      dataMode: "live",
    };
  } catch {
    return { satellites: [starcloudFallback], dataMode: "demo" };
  }
}
