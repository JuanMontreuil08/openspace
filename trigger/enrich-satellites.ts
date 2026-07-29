import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { createClient } from "@supabase/supabase-js";
import { logger, task } from "@trigger.dev/sdk";
import { z } from "zod";
import { sanitizeEnrichmentDescription } from "../lib/sanitize-enrichment";

const OPENAI_MODEL = "gpt-5.6-luna";
const MISSION_SOURCE_LABEL = "OpenAI mission research";
const OPERATOR_SOURCE_LABEL = "OpenAI operator research";
const LEGACY_MISSION_SOURCE_LABEL = "Groq mission research";
const LEGACY_OPERATOR_SOURCE_LABEL = "Groq operator research";

const enrichmentPayloadSchema = z.object({
  noradId: z.number().int().positive(),
  overwrite: z.boolean().default(false),
});

const sourceLinkSchema = z.object({
  label: z.string(),
  url: z.string().url(),
});

const enrichmentRowSchema = z.object({
  norad_id: z.number().int().positive(),
  cospar_id: z.string().nullable(),
  name: z.string(),
  alternate_name: z.string().nullable(),
  operator: z.string().nullable(),
  manufacturer: z.string().nullable(),
  country: z.string().nullable(),
  launch_date: z.string().nullable(),
  function: z.string().nullable(),
  operator_description: z.string().nullable(),
  source_urls: z.array(sourceLinkSchema),
  mission_enriched_at: z.string().nullable(),
  operator_enriched_at: z.string().nullable(),
});

type EnrichmentRow = z.infer<typeof enrichmentRowSchema>;
type SourceLink = z.infer<typeof sourceLinkSchema>;

const researchResultSchema = z.object({
  identityConfirmed: z.boolean(),
  missionDescription: z.string().min(80).max(500).nullable(),
  missionSourceUrls: z.array(z.string()).max(10),
  operatorDescription: z.string().min(80).max(500).nullable(),
  operatorSourceUrls: z.array(z.string()).max(10),
  missionEvidenceSufficient: z.boolean(),
  operatorEvidenceSufficient: z.boolean(),
});

type ResearchResult = z.infer<typeof researchResultSchema>;

type OperatorEnrichment = {
  description: string;
  sources: SourceLink[];
};

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

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY must be configured in Trigger.dev.",
    );
  }
  return new OpenAI({
    apiKey,
    maxRetries: 4,
    timeout: 120_000,
  });
}

function operatorKey(operator: string) {
  return operator.trim();
}

function isMissionResearchSource(label: string) {
  return (
    label === MISSION_SOURCE_LABEL ||
    label === LEGACY_MISSION_SOURCE_LABEL
  );
}

function isOperatorResearchSource(label: string) {
  return (
    label === OPERATOR_SOURCE_LABEL ||
    label === LEGACY_OPERATOR_SOURCE_LABEL
  );
}

function uniqueSources(sources: SourceLink[]) {
  const byUrl = new Map<string, SourceLink>();
  for (const source of sources) {
    const existing = byUrl.get(source.url);
    const isOperatorResearch = isOperatorResearchSource(source.label);
    const isMissionResearch =
      isMissionResearchSource(source.label) &&
      !isOperatorResearchSource(existing?.label ?? "");
    if (!existing || isOperatorResearch || isMissionResearch) {
      byUrl.set(source.url, source);
    }
  }
  return [...byUrl.values()];
}

function labeledSources(urls: string[], label: string) {
  return urls.map((url) => ({ label, url }));
}

function sourceUrlsForPrompt(sources: SourceLink[]) {
  return [...new Set(sources.map((source) => source.url))].slice(0, 20);
}

function researchPrompt(
  satellite: EnrichmentRow,
  needsMission: boolean,
  needsOperator: boolean,
) {
  return `Research this satellite using live web sources and return a factual editorial enrichment.

Identity:
${JSON.stringify(
  {
    name: satellite.name,
    alternateName: satellite.alternate_name,
    noradId: satellite.norad_id,
    cosparId: satellite.cospar_id,
    operator: satellite.operator,
    manufacturer: satellite.manufacturer,
    country: satellite.country,
    launchDate: satellite.launch_date,
    currentMissionCategory: satellite.function,
    knownSourceUrls: sourceUrlsForPrompt(satellite.source_urls),
  },
  null,
  2,
)}

Requirements:
- Confirm that the sources refer to this exact satellite using its name, NORAD ID, COSPAR ID, launch context, or a compatible combination of those identifiers.
- Prioritize official operator, manufacturer, launch-provider, government, space-agency, and scientific sources.
- Do not infer mission capabilities only from the current generic category.
- Search the web before answering and use only facts supported by pages you opened.
- Each supported description must be neutral English, 2 or 3 sentences, and 80–500 characters.
- Write plain prose only. Do not include citations, Markdown links, source names in parentheses, or raw URLs in either description; URLs belong only in the source arrays.
- Research the mission: ${needsMission ? "yes" : "no; return null, an empty source array, and false"}.
- Research the operator: ${needsOperator ? "yes" : "no; return null, an empty source array, and false"}.
- Put the exact URLs used for mission facts in missionSourceUrls and operator facts in operatorSourceUrls.
- If evidence is insufficient or identity is ambiguous, return null for the unsupported description, an empty source array, and false.`;
}

async function researchSatellite(
  openai: OpenAI,
  satellite: EnrichmentRow,
  needsMission: boolean,
  needsOperator: boolean,
) {
  const response = await openai.responses.parse({
    model: OPENAI_MODEL,
    instructions:
      "You are a careful satellite catalog researcher. Distinguish similarly named spacecraft, prefer primary sources, and never invent missing facts or URLs.",
    input: researchPrompt(satellite, needsMission, needsOperator),
    tools: [{ type: "web_search", search_context_size: "low" }],
    tool_choice: "required",
    max_tool_calls: 3,
    max_output_tokens: 1_500,
    reasoning: { effort: "low" },
    include: ["web_search_call.action.sources"],
    store: false,
    text: {
      format: zodTextFormat(
        researchResultSchema,
        "satellite_enrichment",
      ),
    },
  });

  const result = response.output_parsed;
  if (!result) {
    throw new Error("OpenAI returned no structured enrichment.");
  }

  const sourceByKey = new Map<string, string>();
  const addSource = (value: string | null | undefined) => {
    if (!value) return;
    try {
      const parsed = new URL(value);
      parsed.hash = "";
      for (const key of [...parsed.searchParams.keys()]) {
        if (key.toLowerCase().startsWith("utm_")) {
          parsed.searchParams.delete(key);
        }
      }
      sourceByKey.set(
        parsed.toString().replace(/\/$/, ""),
        value,
      );
    } catch {
      // Ignore malformed URLs returned by search metadata.
    }
  };

  for (const item of response.output) {
    if (item.type !== "web_search_call") continue;
    if (item.action.type === "search") {
      for (const source of item.action.sources ?? []) {
        addSource(source.url);
      }
    } else {
      addSource(item.action.url);
    }
  }

  const verifiedSourceUrls = (urls: string[]) =>
    urls.flatMap((url) => {
      try {
        const parsed = new URL(url);
        parsed.hash = "";
        for (const key of [...parsed.searchParams.keys()]) {
          if (key.toLowerCase().startsWith("utm_")) {
            parsed.searchParams.delete(key);
          }
        }
        const verified = sourceByKey.get(
          parsed.toString().replace(/\/$/, ""),
        );
        return verified ? [verified] : [];
      } catch {
        return [];
      }
    });

  return {
    ...result,
    missionSourceUrls: verifiedSourceUrls(result.missionSourceUrls),
    operatorSourceUrls: verifiedSourceUrls(result.operatorSourceUrls),
  } satisfies ResearchResult;
}

async function loadOperationalRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  noradId: number,
) {
  const { data, error } = await supabase
    .from("satellites")
    .select(
      "norad_id, cospar_id, name, alternate_name, operator, manufacturer, country, launch_date, function, operator_description, source_urls, mission_enriched_at, operator_enriched_at",
    )
    .eq("status", "operational")
    .eq("norad_id", noradId)
    .limit(1);

  if (error) throw error;
  return enrichmentRowSchema.array().parse(data ?? []);
}

async function loadCachedOperator(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  operator: string,
) {
  const { data, error } = await supabase
    .from("satellites")
    .select("operator_description, source_urls")
    .eq("status", "operational")
    .eq("operator", operator)
    .not("operator_enriched_at", "is", null)
    .not("operator_description", "is", null)
    .limit(20);

  if (error) throw error;

  for (const row of data ?? []) {
    const description =
      typeof row.operator_description === "string"
        ? row.operator_description
        : null;
    const parsedSources = sourceLinkSchema
      .array()
      .safeParse(row.source_urls ?? []);
    const sources = parsedSources.success
      ? parsedSources.data.filter(
          (source) => isOperatorResearchSource(source.label),
        )
      : [];

    if (description && sources.length > 0) {
      return {
        description: sanitizeEnrichmentDescription(description),
        sources,
      } satisfies OperatorEnrichment;
    }
  }

  return null;
}

function statusFromError(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }
  return null;
}

async function countFullyEnriched(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  noradId: number,
) {
  const query = supabase
    .from("satellites")
    .select("norad_id", { count: "exact", head: true })
    .eq("status", "operational")
    .eq("norad_id", noradId)
    .not("mission_enriched_at", "is", null)
    .not("operator_enriched_at", "is", null);

  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

export const enrichSatelliteCatalog = task({
  id: "enrich-satellite-catalog",
  maxDuration: 3_600,
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 2 },
  run: async (rawPayload: unknown) => {
    const payload = enrichmentPayloadSchema.parse(rawPayload ?? {});
    const supabase = getSupabaseAdmin();
    const openai = getOpenAI();
    const allOperationalRows = await loadOperationalRows(
      supabase,
      payload.noradId,
    );
    const operatorCache = new Map<string, OperatorEnrichment>();
    const selectedOperator = allOperationalRows[0]?.operator;
    if (!payload.overwrite && selectedOperator) {
      const cached = await loadCachedOperator(supabase, selectedOperator);
      if (cached) {
        operatorCache.set(operatorKey(selectedOperator), cached);
      }
    }
    const pendingRows = allOperationalRows
      .filter(
        (row) =>
          payload.overwrite ||
          !row.mission_enriched_at ||
          !row.operator_enriched_at,
      );

    const summary = {
      operational: allOperationalRows.length,
      selected: pendingRows.length,
      processed: 0,
      missionEnriched: 0,
      operatorEnriched: 0,
      fullyEnriched: 0,
      operatorCacheHits: 0,
      insufficientEvidence: 0,
      failed: 0,
      stoppedByRateLimit: false,
      model: OPENAI_MODEL,
    };

    logger.info("Satellite enrichment started", {
      payload,
      operational: summary.operational,
      selected: summary.selected,
      cachedOperators: operatorCache.size,
    });

    for (const satellite of pendingRows) {
      const needsMission =
        payload.overwrite || !satellite.mission_enriched_at;
      const needsOperator =
        Boolean(satellite.operator) &&
        (payload.overwrite || !satellite.operator_enriched_at);
      const key = satellite.operator
        ? operatorKey(satellite.operator)
        : null;
      const cachedOperator = key ? operatorCache.get(key) : undefined;
      const researchNeedsOperator = needsOperator && !cachedOperator;

      try {
        const update: {
          function?: string;
          operator_description?: string;
          source_urls?: SourceLink[];
          mission_enriched_at?: string;
          operator_enriched_at?: string;
        } = {};
        let mergedSources = satellite.source_urls;
        let missionWasEnriched = !needsMission;
        let operatorWasEnriched = !needsOperator;

        if (needsOperator && cachedOperator) {
          update.operator_description = cachedOperator.description;
          update.operator_enriched_at = new Date().toISOString();
          mergedSources = uniqueSources([
            ...mergedSources,
            ...cachedOperator.sources,
          ]);
          operatorWasEnriched = true;
          summary.operatorEnriched += 1;
          summary.operatorCacheHits += 1;
        }

        let research: ResearchResult | null = null;
        if (needsMission || researchNeedsOperator) {
          research = await researchSatellite(
            openai,
            satellite,
            needsMission,
            researchNeedsOperator,
          );
        }

        if (
          needsMission &&
          research?.identityConfirmed &&
          research.missionEvidenceSufficient &&
          research.missionDescription &&
          research.missionSourceUrls.length > 0
        ) {
          const description = sanitizeEnrichmentDescription(
            research.missionDescription,
          );
          const sources = labeledSources(
            research.missionSourceUrls,
            MISSION_SOURCE_LABEL,
          );
          if (description.length >= 80 && description.length <= 500) {
            update.function = description;
            update.mission_enriched_at = new Date().toISOString();
            mergedSources = uniqueSources([...mergedSources, ...sources]);
            missionWasEnriched = true;
            summary.missionEnriched += 1;
          } else {
            summary.insufficientEvidence += 1;
          }
        } else if (needsMission) {
          summary.insufficientEvidence += 1;
        }

        if (
          researchNeedsOperator &&
          research?.identityConfirmed &&
          research.operatorEvidenceSufficient &&
          research.operatorDescription &&
          research.operatorSourceUrls.length > 0 &&
          key
        ) {
          const description = sanitizeEnrichmentDescription(
            research.operatorDescription,
          );
          const sources = labeledSources(
            research.operatorSourceUrls,
            OPERATOR_SOURCE_LABEL,
          );
          const enrichment = {
            description,
            sources,
          };
          if (description.length >= 80 && description.length <= 500) {
            operatorCache.set(key, enrichment);
            update.operator_description = enrichment.description;
            update.operator_enriched_at = new Date().toISOString();
            mergedSources = uniqueSources([...mergedSources, ...sources]);
            operatorWasEnriched = true;
            summary.operatorEnriched += 1;
          } else {
            summary.insufficientEvidence += 1;
          }
        } else if (researchNeedsOperator) {
          summary.insufficientEvidence += 1;
        }

        if (mergedSources !== satellite.source_urls) {
          update.source_urls = mergedSources;
        }

        if (Object.keys(update).length > 0) {
          const { error } = await supabase
            .from("satellites")
            .update(update)
            .eq("norad_id", satellite.norad_id);
          if (error) throw error;
        }

        summary.processed += 1;
        if (missionWasEnriched && operatorWasEnriched) {
          summary.fullyEnriched += 1;
        }
      } catch (error) {
        if (statusFromError(error) === 429) {
          summary.stoppedByRateLimit = true;
          logger.warn("Satellite enrichment stopped by OpenAI rate limit", {
            noradId: satellite.norad_id,
            processed: summary.processed,
            error,
          });
          break;
        }

        summary.failed += 1;
        summary.processed += 1;
        logger.error("Satellite enrichment failed", {
          noradId: satellite.norad_id,
          name: satellite.name,
          error,
        });
      }
    }

    summary.fullyEnriched = await countFullyEnriched(
      supabase,
      payload.noradId,
    );
    logger.info("Satellite enrichment finished", summary);
    return summary;
  },
});
