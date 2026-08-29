-- Run this once in Supabase: SQL Editor → New query → Run

create table if not exists rally_cars (
  id uuid primary key,
  token text not null,
  car_number text not null,
  driver_name text not null,
  color text not null,
  tracking boolean not null default false,
  last jsonb,
  trail jsonb not null default '[]'::jsonb,
  section jsonb,
  updated_at timestamptz not null default now()
);

create unique index if not exists rally_cars_car_number_lower_idx
  on rally_cars (lower(car_number));

alter table rally_cars enable row level security;

alter table rally_cars
  add column if not exists section jsonb;

alter table rally_cars
  add column if not exists crew_status jsonb;

-- Also run supabase/schema_routes.sql for KMZ route sections.
