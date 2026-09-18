-- Run in Supabase SQL Editor (after rally_cars exists)

create table if not exists rally_sections (
  id uuid primary key,
  name text not null,
  type text not null check (type in ('stage', 'road', 'marker')),
  label text not null,
  geometry_type text not null check (geometry_type in ('LineString', 'Polygon', 'Point')),
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

alter table rally_sections
  add column if not exists flag_status text not null default 'green';

alter table rally_sections
  add column if not exists flag_ts bigint not null default 0;

alter table rally_cars
  add column if not exists flag_ack jsonb;

alter table rally_sections
  add column if not exists rally_id uuid;

create index if not exists rally_sections_rally_id_idx on rally_sections (rally_id);

-- Allow KMZ point placemarks (pins) as well as road/stage paths.
do $$
declare
  rec record;
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'rally_sections'
  ) then
    return;
  end if;

  for rec in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'rally_sections'
      and con.contype = 'c'
      and (
        pg_get_constraintdef(con.oid) ilike '%stage%road%'
        or pg_get_constraintdef(con.oid) ilike '%linestring%polygon%'
      )
  loop
    execute format('alter table rally_sections drop constraint if exists %I', rec.conname);
  end loop;

  alter table rally_sections drop constraint if exists rally_sections_type_check;
  alter table rally_sections add constraint rally_sections_type_check
    check (type in ('stage', 'road', 'marker'));

  alter table rally_sections drop constraint if exists rally_sections_geometry_type_check;
  alter table rally_sections add constraint rally_sections_geometry_type_check
    check (geometry_type in ('LineString', 'Polygon', 'Point'));
end $$;

-- Optional open policies if using anon key instead of service_role:
-- create policy "rally_sections_select" on rally_sections for select using (true);
-- create policy "rally_sections_insert" on rally_sections for insert with check (true);
-- create policy "rally_sections_update" on rally_sections for update using (true);
-- create policy "rally_sections_delete" on rally_sections for delete using (true);
