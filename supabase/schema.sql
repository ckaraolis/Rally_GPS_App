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
  updated_at timestamptz not null default now()
);

create unique index if not exists rally_cars_car_number_lower_idx
  on rally_cars (lower(car_number));

alter table rally_cars enable row level security;

-- Server uses the service role key (bypasses RLS).
-- If you use the anon key instead, uncomment these open policies (dev only):
-- create policy "rally_cars_select" on rally_cars for select using (true);
-- create policy "rally_cars_insert" on rally_cars for insert with check (true);
-- create policy "rally_cars_update" on rally_cars for update using (true);
-- create policy "rally_cars_delete" on rally_cars for delete using (true);
