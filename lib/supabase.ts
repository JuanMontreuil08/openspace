import { createClient } from "@supabase/supabase-js";
import { starcloudFallback } from "./starcloud";
import type { SatelliteRecord, SourceLink } from "./types";

type SatelliteRow = {
  norad_id: number;
  satnogs_id: string;
  cospar_id: string;
  name: string;
  alternate_name: string;
  operator: string;
  operator_description: string;
  manufacturer: string;
  country: string;
  launch_date: string;
  status: SatelliteRecord["status"];
  function: string;
  data_center_relation: string;
  inclination_deg: number;
  period_minutes: number;
  tle_line_1: string;
  tle_line_2: string;
  source_urls: SourceLink[];
  source_updated_at: string;
};

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
    tleLine1: row.tle_line_1,
    tleLine2: row.tle_line_2,
    sources: row.source_urls,
    updatedAt: row.source_updated_at,
  };
}

export async function getStarcloud(): Promise<{
  satellite: SatelliteRecord;
  dataMode: "live" | "demo";
}> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    return { satellite: starcloudFallback, dataMode: "demo" };
  }

  try {
    const supabase = createClient(url, key, {
      auth: { persistSession: false },
    });
    const { data, error } = await supabase
      .from("satellites")
      .select("*")
      .eq("norad_id", 66303)
      .single();

    if (error || !data) {
      return { satellite: starcloudFallback, dataMode: "demo" };
    }

    return {
      satellite: mapRow(data as SatelliteRow),
      dataMode: "live",
    };
  } catch {
    return { satellite: starcloudFallback, dataMode: "demo" };
  }
}
