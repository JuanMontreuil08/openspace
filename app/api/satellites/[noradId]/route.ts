import { NextResponse } from "next/server";
import { getSatelliteByNorad } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ noradId: string }> },
) {
  const { noradId: rawNoradId } = await context.params;
  const noradId = Number(rawNoradId);
  if (!Number.isSafeInteger(noradId) || noradId <= 0) {
    return NextResponse.json({ error: "Invalid NORAD ID." }, { status: 400 });
  }

  try {
    const satellite = await getSatelliteByNorad(noradId);
    if (!satellite) {
      return NextResponse.json(
        { error: "Satellite not found." },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { satellite },
      { headers: { "Cache-Control": "public, max-age=60, s-maxage=300" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Satellite details are temporarily unavailable." },
      { status: 503 },
    );
  }
}
