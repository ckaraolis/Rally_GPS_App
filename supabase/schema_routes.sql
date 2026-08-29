-- Run in Supabase SQL Editor (after rally_cars exists)

create table if not exists rally_sections (
  id uuid primary key,
  name text not null,
  type text not null check (type in ('stage', 'road')),
  label text not null,
  geometry_type text not null check (geometry_type in ('LineString', 'Polygon')),
  coordinates jsonb not null,
  source_file text,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists rally_sections_active_idx on rally_sections (active);

alter table rally_sections enable row level security;

alter table rally_cars
  add column if not exists section jsonb;

-- Optional open policies if using anon key instead of service_role:
-- create policy "rally_sections_select" on rally_sections for select using (true);
-- create policy "rally_sections_insert" on rally_sections for insert with check (true);
-- create policy "rally_sections_update" on rally_sections for update using (true);
-- create policy "rally_sections_delete" on rally_sections for delete using (true);
