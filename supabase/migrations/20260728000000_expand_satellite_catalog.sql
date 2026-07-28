alter table public.satellites
add column if not exists orbital_elements jsonb;

alter table public.satellites
  alter column operator drop not null,
  alter column operator_description drop not null,
  alter column operator_description drop default,
  alter column manufacturer drop not null,
  alter column country drop not null,
  alter column launch_date drop not null,
  alter column function drop not null,
  alter column data_center_relation drop not null,
  alter column tle_line_1 drop not null,
  alter column tle_line_2 drop not null;

update public.satellites
set function = null
where function = 'Mission summary pending Gemini enrichment.';

update public.satellites
set operator_description = null
where operator_description = 'Operator summary pending Gemini enrichment.';

create index if not exists satellites_status_name_idx
on public.satellites (status, name);
