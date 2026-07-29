alter table public.satellites
add column if not exists mission_enriched_at timestamptz,
add column if not exists operator_enriched_at timestamptz;

create index if not exists satellites_pending_enrichment_idx
on public.satellites (norad_id)
where status = 'operational'
  and (mission_enriched_at is null or operator_enriched_at is null);
