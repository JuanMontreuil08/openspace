alter table public.satellites
  alter column satnogs_id drop not null,
  alter column cospar_id drop not null,
  alter column alternate_name drop not null;

alter table public.satellites
  add column if not exists mission_category text,
  add column if not exists mission_description text,
  add column if not exists operator_source text,
  add column if not exists gcat_verified_at timestamptz,
  add column if not exists satnogs_verified_at timestamptz;

alter table public.satellites
  add constraint satellites_operator_source_check
  check (operator_source is null or operator_source in ('gcat', 'satnogs', 'ai', 'editorial'))
  not valid;

alter table public.satellites
  validate constraint satellites_operator_source_check;

-- Only text with explicit enrichment provenance is presented as AI research.
update public.satellites
set mission_description = function
where mission_enriched_at is not null;

-- The legacy Starcloud task predated enrichment timestamps. Preserve its researched
-- prose while discarding the original placeholder copy.
update public.satellites
set
  mission_description = function,
  mission_enriched_at = coalesce(mission_enriched_at, synced_at),
  operator_enriched_at = coalesce(operator_enriched_at, synced_at)
where norad_id = 66303
  and function is not null
  and function <> 'Mission summary pending Gemini enrichment.'
  and operator_description is not null
  and operator_description <> 'Operator summary pending Gemini enrichment.';

update public.satellites
set operator_description = null
where operator_enriched_at is null;

update public.satellites
set operator_source = case
  when norad_id = 66303 then 'editorial'
  else 'gcat'
end
where operator is not null
  and operator_source is null;

create index if not exists satellites_operational_norad_idx
on public.satellites (norad_id)
where status = 'operational';

comment on column public.satellites.function is
  'Deprecated deploy-compatibility column. Drop after all old sync workers are retired.';

create table if not exists public.satellite_catalog_staging (
  sync_id text not null,
  norad_id integer not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (sync_id, norad_id)
);

alter table public.satellite_catalog_staging enable row level security;
revoke all on table public.satellite_catalog_staging from public, anon, authenticated;
grant select, insert, update, delete on table public.satellite_catalog_staging to service_role;

create or replace function public.publish_satellite_catalog(
  p_sync_id text,
  p_synced_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  staged_count integer;
begin
  select count(*) into staged_count
  from public.satellite_catalog_staging
  where sync_id = p_sync_id;

  if staged_count < 10000 then
    raise exception 'Refusing to publish truncated satellite catalog: % rows', staged_count;
  end if;

  if exists (
    select payload->>'satnogs_id'
    from public.satellite_catalog_staging
    where sync_id = p_sync_id
      and payload->>'satnogs_id' is not null
    group by payload->>'satnogs_id'
    having count(*) > 1
  ) then
    raise exception 'Refusing to publish duplicate SatNOGS IDs';
  end if;

  update public.satellites as current
  set satnogs_id = null
  where current.satnogs_id is not null
    and exists (
      select 1
      from public.satellite_catalog_staging as staged
      where staged.sync_id = p_sync_id
        and staged.payload->>'satnogs_id' = current.satnogs_id
        and staged.norad_id <> current.norad_id
    );

  insert into public.satellites (
    norad_id, satnogs_id, cospar_id, name, alternate_name, operator,
    operator_source, operator_description, manufacturer, country, launch_date,
    status, mission_category, mission_description, data_center_relation,
    inclination_deg, period_minutes, orbital_elements, tle_line_1, tle_line_2,
    source_urls, mission_enriched_at, operator_enriched_at, gcat_verified_at,
    satnogs_verified_at, source_updated_at, synced_at
  )
  select
    incoming.norad_id, incoming.satnogs_id, incoming.cospar_id, incoming.name,
    incoming.alternate_name, incoming.operator, incoming.operator_source,
    incoming.operator_description, incoming.manufacturer, incoming.country,
    incoming.launch_date, incoming.status, incoming.mission_category,
    incoming.mission_description, incoming.data_center_relation,
    incoming.inclination_deg, incoming.period_minutes, incoming.orbital_elements,
    incoming.tle_line_1, incoming.tle_line_2, incoming.source_urls,
    incoming.mission_enriched_at, incoming.operator_enriched_at,
    incoming.gcat_verified_at, incoming.satnogs_verified_at,
    incoming.source_updated_at, incoming.synced_at
  from public.satellite_catalog_staging as staged
  cross join lateral jsonb_populate_record(
    null::public.satellites,
    staged.payload
  ) as incoming
  where staged.sync_id = p_sync_id
  on conflict (norad_id) do update set
    satnogs_id = excluded.satnogs_id,
    cospar_id = excluded.cospar_id,
    name = excluded.name,
    alternate_name = excluded.alternate_name,
    operator = case
      when excluded.operator_source in ('gcat', 'satnogs') then excluded.operator
      else satellites.operator
    end,
    operator_source = case
      when excluded.operator_source in ('gcat', 'satnogs') then excluded.operator_source
      else satellites.operator_source
    end,
    operator_description = case
      when excluded.operator_source in ('gcat', 'satnogs')
        and satellites.operator is distinct from excluded.operator then null
      else satellites.operator_description
    end,
    operator_enriched_at = case
      when excluded.operator_source in ('gcat', 'satnogs')
        and satellites.operator is distinct from excluded.operator then null
      else satellites.operator_enriched_at
    end,
    manufacturer = excluded.manufacturer,
    country = excluded.country,
    launch_date = excluded.launch_date,
    status = 'operational',
    mission_category = excluded.mission_category,
    mission_description = satellites.mission_description,
    mission_enriched_at = satellites.mission_enriched_at,
    data_center_relation = satellites.data_center_relation,
    inclination_deg = excluded.inclination_deg,
    period_minutes = excluded.period_minutes,
    orbital_elements = excluded.orbital_elements,
    tle_line_1 = excluded.tle_line_1,
    tle_line_2 = excluded.tle_line_2,
    source_urls = (
      select coalesce(jsonb_agg(source.value), '[]'::jsonb)
      from (
        select distinct value
        from jsonb_array_elements(excluded.source_urls) as catalog(value)
        where catalog.value->>'label' in ('CelesTrak', 'SatNOGS DB', 'GCAT', 'Mission website')
        union
        select distinct value
        from jsonb_array_elements(satellites.source_urls) as evidence(value)
        where evidence.value->>'label' not in ('CelesTrak', 'SatNOGS DB', 'GCAT', 'Mission website')
          and not (
            excluded.operator_source in ('gcat', 'satnogs')
            and satellites.operator is distinct from excluded.operator
            and lower(evidence.value->>'label') like '%operator research%'
          )
      ) as source
    ),
    gcat_verified_at = excluded.gcat_verified_at,
    satnogs_verified_at = excluded.satnogs_verified_at,
    source_updated_at = excluded.source_updated_at,
    synced_at = excluded.synced_at;

  update public.satellites
  set status = 'inactive'
  where status = 'operational'
    and synced_at <> p_synced_at;

  delete from public.satellite_catalog_staging where sync_id = p_sync_id;
  return staged_count;
end;
$$;

revoke all on function public.publish_satellite_catalog(text, timestamptz)
from public, anon, authenticated;
grant execute on function public.publish_satellite_catalog(text, timestamptz)
to service_role;

create or replace function public.apply_satellite_enrichment(
  p_norad_id integer,
  p_expected_operator text,
  p_operator_name text,
  p_mission_description text,
  p_mission_enriched_at timestamptz,
  p_operator_description text,
  p_operator_enriched_at timestamptz,
  p_mission_sources jsonb,
  p_operator_sources jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  operator_matches boolean;
  updated_count integer;
begin
  select case
    when p_expected_operator is null then operator is null and operator_source is null
    else operator = p_expected_operator
  end
  into operator_matches
  from public.satellites
  where norad_id = p_norad_id
  for update;

  if not found then return false; end if;

  update public.satellites
  set
    mission_description = coalesce(p_mission_description, mission_description),
    mission_enriched_at = coalesce(p_mission_enriched_at, mission_enriched_at),
    operator = case
      when operator_matches and operator is null and p_operator_name is not null
        then p_operator_name
      else operator
    end,
    operator_source = case
      when operator_matches and operator is null and p_operator_name is not null
        then 'ai'
      else operator_source
    end,
    operator_description = case
      when operator_matches and p_operator_description is not null
        then p_operator_description
      else operator_description
    end,
    operator_enriched_at = case
      when operator_matches and p_operator_enriched_at is not null
        then p_operator_enriched_at
      else operator_enriched_at
    end,
    source_urls = (
      select coalesce(jsonb_agg(source.value), '[]'::jsonb)
      from (
        select distinct value from jsonb_array_elements(source_urls) as current(value)
        union
        select distinct value
        from jsonb_array_elements(coalesce(p_mission_sources, '[]'::jsonb)) as mission(value)
        where p_mission_description is not null
        union
        select distinct value
        from jsonb_array_elements(coalesce(p_operator_sources, '[]'::jsonb)) as operator_evidence(value)
        where operator_matches and p_operator_description is not null
      ) as source
    )
  where norad_id = p_norad_id;

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke all on function public.apply_satellite_enrichment(
  integer, text, text, text, timestamptz, text, timestamptz, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.apply_satellite_enrichment(
  integer, text, text, text, timestamptz, text, timestamptz, jsonb, jsonb
) to service_role;
