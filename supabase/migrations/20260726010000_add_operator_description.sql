alter table public.satellites
add column if not exists operator_description text not null
default 'Operator summary pending Gemini enrichment.';
