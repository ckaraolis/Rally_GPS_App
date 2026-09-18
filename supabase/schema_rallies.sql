-- Run in Supabase SQL Editor so race control can create rallies and keep history.

create table if not exists rally_events (
  id uuid primary key,
  name text not null,
  start_date date,
  end_date date,
  status text not null default 'draft' check (status in ('draft', 'live', 'ended')),
  snapshot jsonb,
  pin_icons jsonb,
  car_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rally_events_status_idx on rally_events (status);
create index if not exists rally_events_created_idx on rally_events (created_at desc);

alter table rally_events enable row level security;

create table if not exists rally_control_users (
  username text primary key,
  password_salt text not null,
  password_hash text not null,
  must_change boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table rally_control_users enable row level security;

alter table rally_events
  add column if not exists pin_icons jsonb;

-- Attach each KMZ/route to one rally event (not a single system-wide route).
-- Requires rally_sections from schema_routes.sql.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'rally_sections'
  ) then
    alter table rally_sections add column if not exists rally_id uuid;
    if not exists (
      select 1 from pg_indexes
      where schemaname = 'public' and indexname = 'rally_sections_rally_id_idx'
    ) then
      create index rally_sections_rally_id_idx on rally_sections (rally_id);
    end if;
  end if;
end $$;

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

