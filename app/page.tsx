import { SpaceExplorer } from "@/components/SpaceExplorer";
import { getSatelliteExplorerData } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { catalog, initialSatellite, dataMode } =
    await getSatelliteExplorerData();
  return (
    <SpaceExplorer
      catalog={catalog}
      initialSatellite={initialSatellite}
      dataMode={dataMode}
    />
  );
}
