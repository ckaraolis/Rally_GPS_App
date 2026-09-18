-- Run in Supabase SQL Editor so race control can create rallies and keep history.

create table if not exists rally_events (
  id uuid primary key,
  name text not null,
  start_date date,
  end_date date,
  status text not null default 'draft' check (status in ('draft', 'live', 'ended')),
  snapshot jsonb,
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

