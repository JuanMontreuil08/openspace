# OpenSpace

OpenSpace is an interactive visual field guide to satellites orbiting Earth. It
combines orbital tracking, mission information, operator context, and educational
storytelling in a minimal space interface.

The catalog joins operational SatNOGS records to CelesTrak active orbital data.
Only unique NORAD matches are published; ambiguous records and records without a
current orbit are excluded.

## What works today

- A minimal interactive Earth and satellite scene.
- A navigable catalog of uniquely matched operational satellites.
- Starcloud-1 mission, operator, manufacturer, launch year, status, and source
  links when its optional editorial enrichment is present.
- Latitude and longitude propagated locally every second from the latest OMM
  elements.
- Smooth satellite marker movement without calling an external API every
  second.
- A three-hour scheduled bulk ingestion task for fresh CelesTrak and SatNOGS
  data.
- A daily GCAT metadata task that prepares a normalized snapshot for the
  three-hour ingestion.
- One-time Gemini summaries for the mission function and operator description.
- On-demand OpenAI web research for enriching the selected satellite's mission
  and operator descriptions, with source links and persistent completion
  tracking.
- Latest-source snapshots stored in Supabase Storage and replaced on every
  successful ingestion.

## Architecture

- **Next.js and TypeScript** provide the web application and server-side data
  loading.
- **React Three Fiber** renders the interactive orbital scene.
- **satellite.js** propagates the selected satellite from stored CelesTrak OMM
  elements in the browser.
- **Supabase Postgres** stores normalized satellite records and orbital
  elements.
- **Supabase Storage** stores the latest raw source responses for traceability.
- **Trigger.dev** schedules and observes ingestion runs.
- **Gemini 3.5 Flash-Lite** creates concise educational summaries from supplied
  source text.
- **OpenAI Responses API** performs live web research for explicit, per-satellite
  enrichment requests.

The app includes a local Starcloud-1 fallback, so the visual experience remains
available before Supabase is configured. GCAT completes the structured card
metadata that is absent from the SatNOGS and CelesTrak orbital feeds. Generated
operator descriptions state only GCAT's recorded owner, organization class, and
location; richer hand-curated text is preserved when available.

## Validate catalog coverage locally

Before expanding the ingestion task, measure how many operational SatNOGS
records can be joined safely to the CelesTrak active catalog:

```bash
npm run validate:satellites
```

The validator uses `norad_follow_id` when SatNOGS has replaced a temporary
catalog ID, otherwise it uses `norad_cat_id`. It excludes NORAD IDs shared by
multiple SatNOGS records and objects that GCAT does not classify as payloads,
verifies that the CelesTrak OMM data can be propagated with `satellite.js`, and
reports coverage for every field in the current card.

To repeat a validation from previously downloaded responses without making
network requests:

```bash
npm run validate:satellites -- \
  --satnogs-file /path/to/satnogs.json \
  --celestrak-file /path/to/celestrak.json \
  --gcat-objects-file /path/to/satcat.tsv \
  --gcat-extended-objects-file /path/to/satcat100k.tsv \
  --gcat-payloads-file /path/to/psatcat.tsv \
  --gcat-extended-payloads-file /path/to/psatcat100k.tsv \
  --gcat-organizations-file /path/to/orgs.tsv
```

## Data flow

1. Trigger.dev runs `sync-gcat-metadata` once a day.
2. The task downloads the GCAT object, payload, and organization tables,
   validates them, and stores both compressed source snapshots and a normalized
   satellite-metadata snapshot.
3. Trigger.dev runs `sync-satellite-catalog` every three hours.
4. The catalog task downloads SatNOGS and the CelesTrak active OMM catalog, then
   joins them to the normalized daily GCAT snapshot.
5. `norad_follow_id` is preferred over temporary `norad_cat_id` values.
6. Records without an active CelesTrak orbit and NORAD IDs shared by multiple
   SatNOGS records are excluded.
7. GCAT confirms that each record is a payload and supplies the launch date,
   alternate identity, operator, manufacturer, country, and mission category.
8. Existing editorial fields are preserved while source fields are upserted in
   batches. Missing function and operator-description text is generated
   deterministically from the GCAT category and organization metadata.
9. Records absent from the newest successful catalog are marked inactive.
10. The latest raw responses replace the previous files in Supabase Storage.
11. The web app loads all operational rows and calculates only the selected
    satellite position every second.
12. When a visitor requests enrichment, the Next.js server queues one
    NORAD-scoped Trigger.dev run. Supported descriptions and their source URLs
    are written back to Supabase and immediately refreshed in the open card.

`source_updated_at` stores the OMM epoch supplied by CelesTrak. `synced_at`
stores the time when OpenSpace successfully completed its latest ingestion.

## Local setup

Requirements:

- Node.js 22.13 or newer
- npm
- A Supabase project
- A Trigger.dev project
- A Gemini API key only when regenerating summaries
- An OpenAI API key only when using on-demand web enrichment

Setup:

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Create the local environment file:

   ```bash
   cp .env.example .env.local
   ```

3. Add the required values to `.env.local`.
4. Run the SQL migrations in `supabase/migrations` in filename order.
5. Start the application:

   ```bash
   npm run dev
   ```

6. Open `http://localhost:3000`.

## Trigger.dev setup

Configure these variables in the relevant Trigger.dev environment:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GEMINI_API_KEY` only for the manual Gemini task
- `OPENAI_API_KEY` for on-demand satellite enrichment

The Next.js server also needs `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, and `TRIGGER_SECRET_KEY`. These values stay on the
server and must never use the `NEXT_PUBLIC_` prefix.

For local task development:

```bash
npm run trigger:dev
```

To publish the tasks and activate the production schedule:

```bash
npm run trigger:deploy
```

### Enrich satellite descriptions

Each operational satellite card exposes one `Enhance with AI` action. The
server queues `enrich-satellite-catalog` with that satellite's NORAD ID, polls
the run, and refreshes the mission, operator description, and cited sources in
the open card. Apply `20260728010000_add_enrichment_tracking.sql` before using
the action.

```json
{ "noradId": 25544 }
```

The task requires `noradId`, so it cannot accidentally process the full
catalog. The public route never enables `overwrite`, refuses already enriched
rows, and deduplicates repeated requests for the same satellite. The task
uses `gpt-5.6-luna` through the OpenAI Responses API to search the web and
produce validated structured output in one request. It reuses an existing
researched operator by exact name, preserves current copy when evidence is
insufficient, strips citations and raw URLs from display copy, saves each
supported field immediately, and logs the result. Research URLs remain in the
card's source list.
`overwrite: true` remains available only when an administrator manually
triggers a deliberate regeneration.

After applying all Supabase migrations and running
`sync-gcat-metadata` followed by `sync-satellite-catalog`, verify the connected
catalog:

```bash
npm run check:catalog
```

The check fails until the `orbital_elements` migration exists and every
operational row has OMM data from the same catalog sync.

`sync-satellite-catalog` uses the declarative cron schedule `0 */3 * * *`, which
runs at the start of every third hour in UTC. Trigger.dev provides the run
history, logs, retries, and failure alerts. A successful run also updates
`satellites.synced_at` in Supabase.

`sync-gcat-metadata` uses `0 2 * * *`, so GCAT is downloaded and normalized once
per day at 02:00 UTC. The following 03:00 UTC catalog run consumes that prepared
snapshot.

The `generate-starcloud-1-summaries` task is intentionally manual. It updates
`satellites.function` and `satellites.operator_description`, then stores its
latest generated output in Supabase Storage. It only needs to run when a
satellite is added, its source description changes, or the summarization prompt
is improved.

## Data sources

- [CelesTrak](https://celestrak.org/): orbital identity and general perturbation
  elements.
- [SatNOGS DB](https://db.satnogs.org/): mission identity, aliases, launch date,
  status, and community radio information.
- [GCAT](https://planet4589.org/space/gcat/): payload classification, launch
  metadata, alternate identity, owner/operator, manufacturer, country, and
  organization metadata.
- [Starcloud](https://www.starcloud.com/): first-party operator and mission
  context.

## Security

- `.env.local` and all other environment files are ignored by Git.
- `.env.example` contains variable names and placeholders only.
- The Supabase service-role key, Trigger.dev secret, Gemini API key, and OpenAI
  API key remain server-side and must never be exposed to the browser.
- Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are
  intended for the public web application.
- The enrichment endpoint is intentionally available to public visitors. It
  scopes each request to one operational NORAD ID, prevents overwrite, rejects
  completed rows, and deduplicates short-window repeats. Add authentication or
  a server-side usage quota before promoting the app to untrusted high-traffic
  audiences.

## Next steps

1. Show a clear public distinction between the position calculated every second
   and the CelesTrak OMM epoch stored in `source_updated_at`.
2. Add a human-readable location such as “Above the central Pacific Ocean”
   without replacing the precise coordinates.
3. Add a server-side enrichment quota or authenticated administrator mode for
   predictable OpenAI spending on a public deployment.
4. Add filters for country, launch year, and orbital inclination.
5. Review excluded ambiguous NORAD groups when SatNOGS identity data changes.
