# OpenSpace

OpenSpace is an interactive visual field guide to satellites orbiting Earth. It
combines orbital tracking, mission information, operator context, and educational
storytelling in a minimal space interface.

The current MVP validates the complete experience with one satellite:
Starcloud-1 (NORAD 66303).

## What works today

- A minimal interactive Earth and satellite scene.
- Starcloud-1 mission, operator, manufacturer, launch year, status, and source
  links.
- Latitude and longitude propagated locally every second from the latest TLE.
- Smooth satellite marker movement without calling an external API every
  second.
- A three-hour scheduled ingestion task for fresh CelesTrak and SatNOGS data.
- One-time Gemini summaries for the mission function and operator description.
- Latest-source snapshots stored in Supabase Storage and replaced on every
  successful ingestion.

## Architecture

- **Next.js and TypeScript** provide the web application and server-side data
  loading.
- **React Three Fiber** renders the interactive orbital scene.
- **satellite.js** propagates the current position from the stored TLE in the
  browser.
- **Supabase Postgres** stores normalized satellite records and the latest TLE.
- **Supabase Storage** stores the latest raw source responses for traceability.
- **Trigger.dev** schedules and observes ingestion runs.
- **Gemini 3.5 Flash-Lite** creates concise educational summaries from supplied
  source text.

The app includes a local Starcloud-1 fallback, so the visual experience remains
available before Supabase is configured.

## Data flow

1. Trigger.dev runs `sync-starcloud-1` every three hours.
2. The task downloads CelesTrak JSON, the CelesTrak TLE, and the SatNOGS record.
3. Source identifiers are validated before any database update.
4. The latest normalized record is upserted into Supabase Postgres.
5. The latest raw responses replace the previous files in Supabase Storage.
6. The web app reads the TLE once and calculates the current position locally
   every second.

`source_updated_at` stores the TLE epoch supplied by CelesTrak. `synced_at`
stores the time when OpenSpace successfully completed its latest ingestion.

## Local setup

Requirements:

- Node.js 22.13 or newer
- npm
- A Supabase project
- A Trigger.dev project
- A Gemini API key only when regenerating summaries

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

For local task development:

```bash
npm run trigger:dev
```

To publish the tasks and activate the production schedule:

```bash
npm run trigger:deploy
```

`sync-starcloud-1` uses the declarative cron schedule `0 */3 * * *`, which runs
at the start of every third hour in UTC. Trigger.dev provides the run history,
logs, retries, and failure alerts. A successful run also updates
`satellites.synced_at` in Supabase.

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
- [Starcloud](https://www.starcloud.com/): first-party operator and mission
  context.

## Security

- `.env.local` and all other environment files are ignored by Git.
- `.env.example` contains variable names and placeholders only.
- The Supabase service-role key and Gemini API key are used only by Trigger.dev
  tasks and must never be exposed to the browser.
- Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are
  intended for the public web application.

## Next steps

1. Show a clear public distinction between the position calculated every second
   and the CelesTrak TLE epoch stored in `source_updated_at`.
2. Add a human-readable location such as “Above the central Pacific Ocean”
   without replacing the precise coordinates.
3. Generalize the ingestion task from Starcloud-1 to a curated catalog of three
   to five satellites.
4. Load multiple satellite rows in the web app, render multiple markers, and
   enable previous/next navigation.
5. Make Gemini enrichment accept a satellite and operator URL while keeping it
   manual or change-driven.
6. Move to CelesTrak bulk feeds and controlled rendering only when the catalog
   grows beyond the curated MVP.

The immediate product milestone is a small, trustworthy satellite catalog. A
full visualization of every active orbital object will require a separate
bulk-ingestion and rendering strategy.
