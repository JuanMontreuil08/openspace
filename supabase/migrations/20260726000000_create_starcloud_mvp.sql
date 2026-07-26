create table if not exists public.satellites (
  norad_id integer primary key,
  satnogs_id text not null unique,
  cospar_id text not null,
  name text not null,
  alternate_name text not null default '',
  operator text not null,
  operator_description text not null default 'Operator summary pending Gemini enrichment.',
  manufacturer text not null,
  country text not null,
  launch_date timestamptz not null,
  status text not null check (status in ('operational', 'inactive', 'unknown')),
  function text not null,
  data_center_relation text not null,
  inclination_deg double precision not null,
  period_minutes double precision not null,
  tle_line_1 text not null,
  tle_line_2 text not null,
  source_urls jsonb not null default '[]'::jsonb,
  source_updated_at timestamptz not null,
  synced_at timestamptz not null default now()
);

alter table public.satellites enable row level security;

create policy "Satellite records are publicly readable"
on public.satellites
for select
to anon, authenticated
using (true);

insert into storage.buckets (id, name, public)
values ('source-snapshots', 'source-snapshots', false)
on conflict (id) do nothing;

insert into public.satellites (
  norad_id,
  satnogs_id,
  cospar_id,
  name,
  alternate_name,
  operator,
  operator_description,
  manufacturer,
  country,
  launch_date,
  status,
  function,
  data_center_relation,
  inclination_deg,
  period_minutes,
  tle_line_1,
  tle_line_2,
  source_urls,
  source_updated_at
)
values (
  66303,
  'MEKC-1774-6115-5644-8771',
  '2025-248L',
  'STARCLOUD-1',
  'LUMEN-1',
  'Starcloud',
  'Operator summary pending Gemini enrichment.',
  'Astro Digital (satellite platform)',
  'United States',
  '2025-11-02T05:09:00Z',
  'operational',
  'Mission summary pending Gemini enrichment.',
  'Orbital compute demonstrator',
  45.3997,
  94.63,
  '1 66303U 25248L   26207.16029198  .00005005  00000+0  22976-3 0  9990',
  '2 66303  45.3997 271.0639 0006321 268.1150  91.9012 15.21652070 40476',
  '[
    {"label":"CelesTrak","url":"https://celestrak.org/NORAD/elements/gp.php?CATNR=66303&FORMAT=JSON"},
    {"label":"SatNOGS DB","url":"https://db.satnogs.org/satellite/MEKC-1774-6115-5644-8771/"},
    {"label":"Starcloud","url":"https://www.starcloud.com/starcloud-1"}
  ]'::jsonb,
  '2026-07-26T03:50:49.227072Z'
)
on conflict (norad_id) do nothing;
