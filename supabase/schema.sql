-- OpenFloat Supabase schema (authoritative)
--
-- Idempotent: safe to run on a brand-new project AND to migrate an existing
-- one. The column set matches exactly what `app/telemetry/sync.js` uploads, so
-- nothing the client sends is silently dropped.
--
-- Setup:
--   1. Paste this whole file into the Supabase SQL editor and run it.
--   2. Authentication -> Providers -> enable "Anonymous sign-ins".
--   3. In the app's Cloud modal, enter the project URL + anon key.
--
-- Notes:
--   * Each browser signs in anonymously, so `auth.uid()` is that browser's
--     stable anonymous user id. Row-Level Security partitions every table by
--     `user_id = auth.uid()` so users never see each other's data.
--   * `shot_traces.payload` and `shot_traces.mic_series` are gzip+base64 text
--     (see the `encoding` column), not JSON. Compressing both keeps a single
--     full-rate shot from writing hundreds of KB of raw JSON.

-- ---------------------------------------------------------------------------
-- Tables (fresh projects)
-- ---------------------------------------------------------------------------

create table if not exists public.users (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at   timestamptz default now()
);

create table if not exists public.bow_profiles (
  id               uuid primary key,
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  model            text,
  draw_weight      numeric,
  arrow_speed      numeric,
  stabilizer_setup text,
  notes            text
);

create table if not exists public.sessions (
  id             uuid primary key,
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  bow_profile_id uuid,
  started_at     timestamptz,
  location_label text
);

create table if not exists public.shots (
  id                uuid primary key,
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  session_id        uuid,
  device_id         text,
  device_shot_id    integer,
  stored_upload     boolean default false,
  timestamp         timestamptz,
  peak_g            numeric,
  cant_angle_deg    numeric,
  pitch_angle_deg   numeric,
  yaw_angle_deg     numeric,
  roll_angle_deg    numeric,
  stability_score   numeric,
  shot_score        numeric,
  hold_stability    numeric,
  release_quality   numeric,
  follow_through    numeric,
  level_consistency numeric,
  score_version     text,
  packet_loss_count integer,
  label             text
);

create table if not exists public.shot_traces (
  shot_id            uuid primary key references public.shots (id) on delete cascade,
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  encoding           text,
  sample_rate_hz     numeric,
  source             text,
  has_mic            boolean default false,
  mic_sample_rate_hz numeric,
  mic_series         text,  -- gzip+base64 (see `encoding`); was jsonb in older drafts
  payload            text   -- gzip+base64 motion samples
);

-- ---------------------------------------------------------------------------
-- Columns added for existing projects (idempotent; nullable so adding to a
-- table that already has rows never fails on the NOT NULL backfill)
-- ---------------------------------------------------------------------------

alter table public.bow_profiles
  add column if not exists user_id     uuid default auth.uid(),
  add column if not exists model       text,
  add column if not exists draw_weight numeric,
  add column if not exists arrow_speed numeric;

alter table public.shots
  add column if not exists user_id           uuid default auth.uid(),
  add column if not exists device_shot_id    integer,
  add column if not exists stored_upload     boolean default false,
  add column if not exists yaw_angle_deg     numeric,
  add column if not exists shot_score        numeric,
  add column if not exists hold_stability    numeric,
  add column if not exists release_quality   numeric,
  add column if not exists follow_through    numeric,
  add column if not exists level_consistency numeric,
  add column if not exists score_version     text,
  add column if not exists packet_loss_count integer,
  add column if not exists label             text;

alter table public.shot_traces
  add column if not exists user_id            uuid default auth.uid(),
  add column if not exists source             text,
  add column if not exists has_mic            boolean default false,
  add column if not exists mic_sample_rate_hz numeric,
  add column if not exists mic_series         text;

-- Older projects may have created shot_traces.mic_series as jsonb. The client
-- now uploads it as gzip+base64 text, so widen the type if needed.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'shot_traces'
      and column_name = 'mic_series' and data_type = 'jsonb'
  ) then
    alter table public.shot_traces
      alter column mic_series type text using mic_series::text;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Dedup index: firmware replays the same device shot on reconnect
-- ---------------------------------------------------------------------------

create unique index if not exists shots_device_shot_id_unique
  on public.shots (device_id, device_shot_id)
  where device_shot_id is not null;

-- ---------------------------------------------------------------------------
-- Row-Level Security: each (anonymous) user manages only their own rows
-- ---------------------------------------------------------------------------

alter table public.users        enable row level security;
alter table public.bow_profiles enable row level security;
alter table public.sessions     enable row level security;
alter table public.shots        enable row level security;
alter table public.shot_traces  enable row level security;

drop policy if exists "users_self" on public.users;
create policy "users_self" on public.users
  for all using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "bow_profiles_owner" on public.bow_profiles;
create policy "bow_profiles_owner" on public.bow_profiles
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "sessions_owner" on public.sessions;
create policy "sessions_owner" on public.sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "shots_owner" on public.shots;
create policy "shots_owner" on public.shots
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "shot_traces_owner" on public.shot_traces;
create policy "shot_traces_owner" on public.shot_traces
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
