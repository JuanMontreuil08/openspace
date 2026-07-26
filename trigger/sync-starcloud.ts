import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";
import { logger, schedules, task } from "@trigger.dev/sdk";
import { z } from "zod";

const NORAD_ID = 66303;
const SATNOGS_ID = "MEKC-1774-6115-5644-8771";
const CELESTRAK_JSON_URL =
  "https://celestrak.org/NORAD/elements/gp.php?CATNR=66303&FORMAT=JSON";
const CELESTRAK_TLE_URL =
  "https://celestrak.org/NORAD/elements/gp.php?CATNR=66303&FORMAT=TLE";
const SATNOGS_URL =
  "https://db.satnogs.org/api/satellites/MEKC-1774-6115-5644-8771/";
const SATNOGS_PAGE_URL =
  "https://db.satnogs.org/satellite/MEKC-1774-6115-5644-8771/";
const STARCLOUD_OPERATOR_URL = "https://www.starcloud.com/";

const celestrakSchema = z
  .array(
    z.object({
      OBJECT_NAME: z.string(),
      OBJECT_ID: z.string(),
      EPOCH: z.string(),
      MEAN_MOTION: z.number(),
      INCLINATION: z.number(),
      NORAD_CAT_ID: z.number(),
    }),
  )
  .length(1);

const satnogsSchema = z.object({
  sat_id: z.string(),
  norad_follow_id: z.number(),
  name: z.string(),
  names: z.string().nullable(),
  status: z.string(),
  launched: z.string(),
  countries: z.string(),
  updated: z.string(),
});

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

async function saveSnapshot(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  filename: string,
  body: string,
  contentType = "application/json",
) {
  const path = `starcloud-1/${filename}`;
  const { error } = await supabase.storage
    .from("source-snapshots")
    .upload(path, body, {
      contentType,
      upsert: true,
    });

  if (error) throw error;
  return path;
}

export const syncStarcloud = schedules.task({
  id: "sync-starcloud-1",
  cron: "0 */3 * * *",
  retry: { maxAttempts: 3 },
  run: async () => {
    const supabase = getSupabaseAdmin();
    const [celestrakJsonText, celestrakTleText, satnogsText] =
      await Promise.all([
        fetchText(CELESTRAK_JSON_URL),
        fetchText(CELESTRAK_TLE_URL),
        fetchText(SATNOGS_URL),
      ]);

    const [celestrak] = celestrakSchema.parse(
      JSON.parse(celestrakJsonText),
    );
    const satnogs = satnogsSchema.parse(JSON.parse(satnogsText));
    const tleLines = celestrakTleText
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trimEnd());

    if (
      celestrak.NORAD_CAT_ID !== NORAD_ID ||
      satnogs.norad_follow_id !== NORAD_ID ||
      satnogs.sat_id !== SATNOGS_ID ||
      tleLines.length < 3
    ) {
      throw new Error("The source identifiers do not match Starcloud-1.");
    }

    const periodMinutes = 1440 / celestrak.MEAN_MOTION;
    const { data: currentSatellite } = await supabase
      .from("satellites")
      .select("function, operator_description")
      .eq("norad_id", NORAD_ID)
      .maybeSingle();
    const snapshotPaths = await Promise.all([
      saveSnapshot(supabase, "celestrak.json", celestrakJsonText),
      saveSnapshot(
        supabase,
        "celestrak.tle",
        celestrakTleText,
        "text/plain",
      ),
      saveSnapshot(supabase, "satnogs.json", satnogsText),
    ]);

    const { error } = await supabase.from("satellites").upsert({
      norad_id: NORAD_ID,
      satnogs_id: SATNOGS_ID,
      cospar_id: celestrak.OBJECT_ID,
      name: celestrak.OBJECT_NAME,
      alternate_name: satnogs.names ?? "",
      operator: "Starcloud",
      manufacturer: "Astro Digital (satellite platform)",
      country: satnogs.countries === "US" ? "United States" : satnogs.countries,
      launch_date: satnogs.launched,
      status: satnogs.status === "alive" ? "operational" : "unknown",
      function:
        currentSatellite?.function ?? "Mission summary pending Gemini enrichment.",
      operator_description:
        currentSatellite?.operator_description ??
        "Operator summary pending Gemini enrichment.",
      data_center_relation: "Orbital compute demonstrator",
      inclination_deg: celestrak.INCLINATION,
      period_minutes: periodMinutes,
      tle_line_1: tleLines[1],
      tle_line_2: tleLines[2],
      source_urls: [
        { label: "CelesTrak", url: CELESTRAK_JSON_URL },
        {
          label: "SatNOGS DB",
          url: `https://db.satnogs.org/satellite/${SATNOGS_ID}/`,
        },
        {
          label: "Starcloud",
          url: "https://www.starcloud.com/starcloud-1",
        },
      ],
      source_updated_at: celestrak.EPOCH,
      synced_at: new Date().toISOString(),
    });

    if (error) throw error;

    logger.info("Starcloud-1 synchronized", {
      noradId: NORAD_ID,
      epoch: celestrak.EPOCH,
      snapshotPaths,
    });

    return {
      noradId: NORAD_ID,
      epoch: celestrak.EPOCH,
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
      "gemini-summaries.json",
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
