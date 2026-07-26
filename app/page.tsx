import { SpaceExplorer } from "@/components/SpaceExplorer";
import { getStarcloud } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { satellite, dataMode } = await getStarcloud();
  return <SpaceExplorer satellite={satellite} dataMode={dataMode} />;
}
