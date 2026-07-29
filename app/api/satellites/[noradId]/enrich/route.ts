import { createClient } from "@supabase/supabase-js";
import {
  idempotencyKeys,
  runs,
  tasks,
} from "@trigger.dev/sdk";
import { NextResponse } from "next/server";
import type { enrichSatelliteCatalog } from "@/trigger/enrich-satellites";

type RouteContext = {
  params: Promise<{ noradId: string }>;
};

const TERMINAL_FAILURES = new Set([
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
]);

function getSupabaseAdmin() {
  const url =
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Satellite enrichment is not configured.");
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function parseNoradId(value: string) {
  const noradId = Number(value);
  return Number.isInteger(noradId) && noradId > 0 ? noradId : null;
}

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

async function loadSatellite(noradId: number) {
  const { data, error } = await getSupabaseAdmin()
    .from("satellites")
    .select(
      "norad_id, status, function, operator_description, source_urls, mission_enriched_at, operator_enriched_at",
    )
    .eq("norad_id", noradId)
    .eq("status", "operational")
    .maybeSingle();

  if (error) throw error;
  return data;
}

function satelliteResponse(
  satellite: NonNullable<Awaited<ReturnType<typeof loadSatellite>>>,
) {
  return {
    noradId: satellite.norad_id,
    function: satellite.function,
    operatorDescription: satellite.operator_description,
    sources: satellite.source_urls ?? [],
    missionEnrichedAt: satellite.mission_enriched_at,
    operatorEnrichedAt: satellite.operator_enriched_at,
  };
}

export async function POST(request: Request, context: RouteContext) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const { noradId: rawNoradId } = await context.params;
  const noradId = parseNoradId(rawNoradId);
  if (!noradId) {
    return NextResponse.json({ error: "Invalid NORAD ID." }, { status: 400 });
  }

  try {
    const satellite = await loadSatellite(noradId);
    if (!satellite) {
      return NextResponse.json(
        { error: "Operational satellite not found." },
        { status: 404 },
      );
    }

    if (
      satellite.mission_enriched_at &&
      satellite.operator_enriched_at
    ) {
      return NextResponse.json({
        status: "already_enriched",
        satellite: satelliteResponse(satellite),
      });
    }

    const idempotencyKey = await idempotencyKeys.create(
      ["satellite-enrichment", String(noradId)],
      { scope: "global" },
    );
    const handle = await tasks.trigger<typeof enrichSatelliteCatalog>(
      "enrich-satellite-catalog",
      { noradId, overwrite: false },
      {
        idempotencyKey,
        idempotencyKeyTTL: "15m",
        tags: [`satellite:${noradId}`],
      },
    );

    return NextResponse.json(
      { status: "queued", runId: handle.id },
      { status: 202 },
    );
  } catch (error) {
    console.error("Unable to queue satellite enrichment", {
      noradId,
      error,
    });
    return NextResponse.json(
      { error: "AI enrichment is temporarily unavailable." },
      { status: 503 },
    );
  }
}

export async function GET(request: Request, context: RouteContext) {
  const { noradId: rawNoradId } = await context.params;
  const noradId = parseNoradId(rawNoradId);
  const runId = new URL(request.url).searchParams.get("runId");

  if (!noradId || !runId?.startsWith("run_")) {
    return NextResponse.json(
      { error: "Invalid enrichment request." },
      { status: 400 },
    );
  }

  try {
    const run = await runs.retrieve(runId);
    const payload = run.payload as { noradId?: unknown } | undefined;

    if (
      run.taskIdentifier !== "enrich-satellite-catalog" ||
      payload?.noradId !== noradId
    ) {
      return NextResponse.json(
        { error: "Enrichment run not found." },
        { status: 404 },
      );
    }

    if (run.status === "COMPLETED") {
      const satellite = await loadSatellite(noradId);
      if (!satellite) {
        return NextResponse.json(
          { error: "Operational satellite not found." },
          { status: 404 },
        );
      }

      const fullyEnriched = Boolean(
        satellite.mission_enriched_at &&
          satellite.operator_enriched_at,
      );
      return NextResponse.json({
        status: fullyEnriched ? "completed" : "needs_review",
        satellite: satelliteResponse(satellite),
      });
    }

    if (TERMINAL_FAILURES.has(run.status)) {
      return NextResponse.json(
        { status: "failed", error: "The enrichment run did not complete." },
        { status: 502 },
      );
    }

    return NextResponse.json({ status: "running" });
  } catch (error) {
    console.error("Unable to read satellite enrichment", {
      noradId,
      runId,
      error,
    });
    return NextResponse.json(
      { error: "Unable to read enrichment status." },
      { status: 503 },
    );
  }
}
