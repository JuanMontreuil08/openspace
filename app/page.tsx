import { SpaceExplorer } from "@/components/SpaceExplorer";
import { getSatellites } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { satellites, dataMode } = await getSatellites();
  return <SpaceExplorer satellites={satellites} dataMode={dataMode} />;
}
