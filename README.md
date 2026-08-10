# COOPER

COOPER is an interactive guide to active satellites orbiting Earth. It brings
together orbital data, mission details, operator information, and source links
in a visual experience designed for exploration rather than specialist analysis.

The catalog follows the active objects published by CelesTrak. Its size changes
as satellites are launched, reclassified, or removed from the active catalog,
but it currently contains roughly 16,000 objects. COOPER keeps all of them
searchable while displaying and calculating the position of only one satellite
at a time.

## What you can do

- Search the complete active satellite catalog by name, alternate name,
  operator, country, or NORAD ID.
- Move to the previous or next satellite with the navigation arrows.
- View a selected satellite's estimated current position and ground track.
- Read its mission, operator, launch, and orbit information when available.
- See the age and epoch of the orbital data used for the position estimate.
- Open the original source links behind the displayed information.
- Request an AI-assisted mission and operator description for a satellite whose
  descriptions have not been researched yet.

Starcloud-1 is selected by default when it is present in the active catalog.

## Understanding the location

COOPER does not receive live GPS or telemetry from satellites. It calculates a
satellite's position with the standard SGP4 orbit model and the latest orbital
elements supplied by CelesTrak.

The **epoch** is the moment when those orbital elements were valid. A recent
epoch usually produces a better estimate. The interface shows both the epoch
and the age of the orbital data so visitors can judge how current the predicted
position is. COOPER also warns when an orbit is older than the accepted
freshness threshold.

The solid path shows the calculated recent track. The dashed path shows the
predicted track. Both are estimates derived from the same orbital elements, not
observations from the spacecraft.

## How COOPER works

```text
CelesTrak active catalog
          |
          v
Validation and orbit checks ---- optional GCAT and SatNOGS metadata
          |
          v
Atomic publication to Supabase
          |
          +---- lightweight searchable index for every active satellite
          |
          +---- full record for the one selected satellite
                           |
                           v
                 SGP4 position and ground track
```

The browser first receives a lightweight index containing the fields needed for
search and navigation. When a visitor selects a satellite, COOPER downloads its
complete record and renders the same detailed card for that satellite. This
keeps all active satellites searchable without sending every orbital record and
description to the browser at once.

## Data sources and ownership

Each source has a defined role. A secondary source cannot overwrite a field
owned by a more authoritative source.

| Source | What it provides | Role in COOPER |
| --- | --- | --- |
| [CelesTrak](https://celestrak.org/) | Active-catalog membership, NORAD and COSPAR identity, primary name, orbital elements, inclination, period, and orbit epoch | Authoritative catalog and orbit source. A satellite appears as active only when it is in this feed. |
| [GCAT](https://planet4589.org/space/gcat/) | Operator, manufacturer, country, launch date, mission category, and alternate names | Preferred structured metadata source when a matching record exists. It does not control catalog inclusion. |
| [SatNOGS DB](https://db.satnogs.org/) | Alternate names, operator, country, launch date, mission website, and SatNOGS identity | Optional fallback metadata and community links. It does not control catalog inclusion. |
| AI-assisted research | Mission description, operator description, and operator name only when direct sources have no operator | On-demand editorial enrichment. It never creates orbital data or decides whether a satellite is active. |

Some fields remain empty because CelesTrak focuses on orbital data and the
optional sources do not cover every satellite. Missing metadata is shown as
unavailable rather than guessed.

## AI-assisted descriptions

AI enrichment runs only when a visitor selects **Enhance with AI** for one
satellite. It researches the exact satellite, checks the identity against its
NORAD ID and other known details, and prefers official or primary web sources.

Supported mission and operator descriptions, the operator name when it was
previously missing, and the research links are stored persistently in Supabase.
Later visits can reuse them. A direct operator value from GCAT or SatNOGS always
takes precedence over an AI-researched operator name. The bulk catalog pipeline
does not generate AI descriptions for all satellites.

## Data pipeline

Trigger.dev runs and monitors three tasks:

### 1. Prepare GCAT metadata

`sync-gcat-metadata` runs daily at 02:00 UTC. It downloads the GCAT object,
payload, and organization tables, normalizes them, and stores compressed source
snapshots in Supabase Storage.

### 2. Publish the active catalog

`sync-satellite-catalog` runs at 03:00, 11:00, and 19:00 UTC. It:

1. Downloads the current CelesTrak active OMM catalog.
2. Loads GCAT and SatNOGS independently as optional metadata sources.
3. Rejects truncated catalogs, duplicate identities, invalid orbital values,
   unexpected catalog shrinkage, and records that cannot be propagated.
4. Builds one normalized record per NORAD ID using the source ownership rules
   above.
5. Stages the complete generation and publishes it to Supabase in one database
   operation, avoiding a partially updated public catalog.
6. Marks records missing from the newest successful CelesTrak catalog as
   inactive.
7. Saves valid source snapshots for traceability and recovery.

If the live CelesTrak request fails, the task may use the last validated
CelesTrak snapshot only while it is less than 24 hours old. Invalid optional
metadata does not stop fresh CelesTrak orbital data from being published.

### 3. Enrich one satellite

`enrich-satellite-catalog` is an on-demand task scoped to one NORAD ID. It uses
OpenAI web research, validates structured results, saves supported fields and
source URLs, and preserves existing direct-source data.

## Technology

| Layer | Technology | Purpose |
| --- | --- | --- |
| Web application | Next.js, React, TypeScript | Server-rendered application and interactive interface |
| Maps and motion | MapLibre GL, Motion | Earth map, ground track, and interface animation |
| Orbit calculation | satellite.js | SGP4 propagation in the browser for the selected satellite |
| Database and storage | Supabase Postgres and Storage | Satellite records, enrichment, staging, and source snapshots |
| Background jobs | Trigger.dev | Scheduled ingestion, retries, logs, and on-demand enrichment |
| AI research | OpenAI Responses API | Evidence-based descriptions requested one satellite at a time |

## Operate and validate the catalog

Deploy the tasks and schedules:

```bash
npm run trigger:deploy
```

Validate live source coverage and orbital propagation without writing to the
database:

```bash
npm run validate:satellites
```

After running `sync-gcat-metadata` and `sync-satellite-catalog`, verify the
published database catalog:

```bash
npm run check:catalog
npm run audit:catalog
```

## Security note

The public enrichment route is limited to one active NORAD ID, refuses to
overwrite completed enrichment, and deduplicates repeated requests. Before a
high-traffic public launch, add authentication or a server-side usage quota to
keep AI spending predictable.
