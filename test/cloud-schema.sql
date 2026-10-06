-- Run with psql in a disposable plain PostgreSQL database named
-- openfloat_schema_test. The auth shim, role, tables, and rows all roll back.
-- Refusing an existing auth schema also guards against a real Supabase project.
\set ON_ERROR_STOP on
\if :{?legacy}
\else
  \set legacy false
\endif

begin;
set local client_min_messages = warning;
do $$
begin
  if current_database() <> 'openfloat_schema_test' then
    raise exception 'Use a disposable database named openfloat_schema_test';
  end if;
end $$;

create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create role openfloat_schema_test_client;
insert into auth.users values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

\ir ../supabase/schema.sql

\if :legacy
  -- Restore the earlier column and index, including metadata and its replay.
  alter table public.shots alter column device_shot_id type integer;
  alter table public.shots drop column if exists capture_kind;
  create unique index if not exists shots_device_shot_id_unique
    on public.shots (device_id, device_shot_id)
    where device_shot_id is not null;
  insert into public.shots (id, user_id, device_id, device_shot_id, timestamp, peak_g)
    values ('00000000-0000-4000-8000-999999999999',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'OpenFloat-Sensor',
      2147483647, '2026-01-01T12:00:00Z', 22.75);
  insert into public.shot_traces (shot_id, user_id, payload)
    values ('00000000-0000-4000-8000-999999999999',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'preserved-legacy-replay');
\endif

-- Test both migration and repeated application before inserting new captures.
\ir ../supabase/schema.sql
\ir ../supabase/schema.sql

grant usage on schema public, auth to openfloat_schema_test_client;
grant select, insert, update, delete on all tables in schema public
  to openfloat_schema_test_client;
set local role openfloat_schema_test_client;
set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

-- Capture type is independent of a user's label and legacy impulse guesses.
insert into public.shots (id, device_id, device_shot_id, capture_kind, label, peak_g)
  select id, 'OpenFloat-BLE:type-sensor', device_shot_id, capture_kind, label, peak_g
  from jsonb_to_recordset('[
    {"id":"00000000-0000-4000-8000-333333333333","capture_kind":"hold","label":"Level Lock","peak_g":5},
    {"id":"00000000-0000-4000-8000-222222222222","device_shot_id":70000,"capture_kind":"arrow","label":"Hold steady","peak_g":3},
    {"id":"00000000-0000-4000-8000-111111111111","label":"Unclassified capture"}
  ]') as capture(id uuid, device_shot_id bigint, capture_kind text, label text, peak_g numeric);
-- Renaming/retrying a completed training capture retains its original type.
insert into public.shots (id, capture_kind, label)
  values ('00000000-0000-4000-8000-333333333333', 'hold', 'Precision practice')
  on conflict (id) do update set capture_kind = excluded.capture_kind, label = excluded.label;
do $$
begin
  if (select capture_kind from public.shots where id = '00000000-0000-4000-8000-333333333333') is distinct from 'hold'
    or (select label from public.shots where id = '00000000-0000-4000-8000-333333333333') is distinct from 'Precision practice'
    or (select capture_kind from public.shots where id = '00000000-0000-4000-8000-222222222222') is distinct from 'arrow'
    or not exists (select 1 from public.shots
      where id = '00000000-0000-4000-8000-111111111111' and capture_kind is null) then
    raise exception 'Cloud sync lost capture type or invented one for a legacy record';
  end if;
end $$;
\echo PASS custom labels and UUID retries retain capture type; untyped records stay null

-- JSON numbers arriving from the browser must survive the database conversion.
insert into public.shots (id, device_id, device_shot_id)
  select ('00000000-0000-4000-8000-' || lpad(device_shot_id::text, 12, '0'))::uuid,
    'OpenFloat-BLE:test-sensor', device_shot_id
  from jsonb_to_recordset('[{"device_shot_id":0},{"device_shot_id":65535},
    {"device_shot_id":65536},{"device_shot_id":2147483647},
    {"device_shot_id":2147483648},{"device_shot_id":4294967294},
    {"device_shot_id":4294967295}]') as capture(device_shot_id bigint);
do $$
begin
  if (select array_agg(device_shot_id order by device_shot_id) from public.shots
      where device_id = 'OpenFloat-BLE:test-sensor')
      is distinct from array[0,65535,65536,2147483647,2147483648,4294967294,4294967295]::bigint[] then
    raise exception 'Cloud capture IDs changed while storing JSON numbers';
  end if;
end $$;
\echo PASS unsigned capture IDs, including zero and the maximum

-- A later capture can reuse the device number but has its own saved UUID.
insert into public.shots (id, device_id, device_shot_id, label)
  values ('00000000-0000-4000-8000-888888888888', 'OpenFloat-BLE:test-sensor', 0, 'later capture');
insert into public.shot_traces (shot_id, payload) values
  ('00000000-0000-4000-8000-000000000000', 'first replay'),
  ('00000000-0000-4000-8000-888888888888', 'later replay');
-- Queue retry / target editing must update only the capture with this UUID.
insert into public.shots (id, device_id, device_shot_id, label)
  values ('00000000-0000-4000-8000-000000000000', 'OpenFloat-BLE:test-sensor', 0, 'retried capture')
  on conflict (id) do update set label = excluded.label;
do $$
begin
  if (select count(*) from public.shots where device_shot_id = 0) <> 2
    or (select label from public.shots where id = '00000000-0000-4000-8000-000000000000') is distinct from 'retried capture'
    or (select label from public.shots where id = '00000000-0000-4000-8000-888888888888') is distinct from 'later capture'
    or (select payload from public.shot_traces where shot_id = '00000000-0000-4000-8000-000000000000') is distinct from 'first replay'
    or (select payload from public.shot_traces where shot_id = '00000000-0000-4000-8000-888888888888') is distinct from 'later replay' then
    raise exception 'UUID upsert merged captures or changed their replays';
  end if;
end $$;
\echo PASS reused device IDs stay separate; UUID retries retain the correct replay

set local request.jwt.claim.sub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
insert into public.shots (id, device_id, device_shot_id)
  values ('00000000-0000-4000-8000-777777777777', 'OpenFloat-BLE:test-sensor', 0);
insert into public.shot_traces (shot_id, payload)
  values ('00000000-0000-4000-8000-777777777777', 'other user replay');
do $$
declare
  changed integer;
begin
  if (select count(*) from public.shots) <> 1
    or (select count(*) from public.shot_traces) <> 1 then
    raise exception 'RLS exposed another user''s captures or replays';
  end if;
  update public.shots set label = 'wrong owner'
    where id = '00000000-0000-4000-8000-000000000000';
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'RLS allowed another user''s update'; end if;
  delete from public.shots where id = '00000000-0000-4000-8000-000000000000';
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'RLS allowed another user''s deletion'; end if;
  begin
    insert into public.shots (id, user_id) values
      ('00000000-0000-4000-8000-666666666666', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    raise exception 'RLS allowed inserting another user''s capture';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.shots set user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      where id = '00000000-0000-4000-8000-777777777777';
    raise exception 'RLS allowed reassigning ownership';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.shots (id, label) values
      ('00000000-0000-4000-8000-000000000000', 'wrong owner')
      on conflict (id) do update set label = excluded.label;
    raise exception 'RLS allowed another user''s UUID upsert';
  exception when insufficient_privilege then null;
  end;
end $$;
\echo PASS matching device IDs across users; RLS read/write/ownership isolation

-- A foreign key checks existence, not whether this user owns the parent shot.
do $$
begin
  begin
    insert into public.shot_traces (shot_id, payload)
      values ('00000000-0000-4000-8000-004294967295', 'foreign capture replay');
    raise exception 'RLS allowed attaching a replay to another user''s capture';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.shot_traces set shot_id = '00000000-0000-4000-8000-002147483648'
      where shot_id = '00000000-0000-4000-8000-777777777777';
    raise exception 'RLS allowed moving a replay to another user''s capture';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.shot_traces (shot_id, payload)
      values ('00000000-0000-4000-8000-004294967295', 'foreign capture upsert')
      on conflict (shot_id) do update set payload = excluded.payload;
    raise exception 'RLS allowed a replay upsert for another user''s capture';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.shot_traces (shot_id, payload)
      values ('00000000-0000-4000-8000-000000000000', 'foreign existing replay')
      on conflict (shot_id) do update set payload = excluded.payload;
    raise exception 'RLS allowed an upsert over another user''s replay';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.shot_traces (shot_id, payload)
      values ('00000000-0000-4000-8000-555555555555', 'missing capture replay');
    raise exception 'RLS allowed a replay without an owned capture';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.shot_traces set user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      where shot_id = '00000000-0000-4000-8000-777777777777';
    raise exception 'RLS allowed reassigning replay ownership';
  exception when insufficient_privilege then null;
  end;
  if (select payload from public.shot_traces
      where shot_id = '00000000-0000-4000-8000-777777777777') is distinct from 'other user replay' then
    raise exception 'Rejected parent changes altered the saved replay';
  end if;
end $$;
\echo PASS replay inserts, parent changes, and upserts require an owned capture

-- Valid trace retries and ordinary edits/deletions still work for their owner.
insert into public.shot_traces (shot_id, user_id, payload)
  values ('00000000-0000-4000-8000-777777777777',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'retried own replay')
  on conflict (shot_id) do update set user_id = excluded.user_id, payload = excluded.payload;
do $$
declare
  changed integer;
begin
  if (select payload from public.shot_traces
      where shot_id = '00000000-0000-4000-8000-777777777777') is distinct from 'retried own replay' then
    raise exception 'An owned replay retry was not saved';
  end if;
  update public.shot_traces set payload = 'updated own replay'
    where shot_id = '00000000-0000-4000-8000-777777777777';
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'An owned replay update was blocked'; end if;
  update public.shot_traces set payload = 'wrong owner'
    where shot_id = '00000000-0000-4000-8000-000000000000';
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'Another user''s replay update was allowed'; end if;
  delete from public.shot_traces where shot_id = '00000000-0000-4000-8000-000000000000';
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'Another user''s replay deletion was allowed'; end if;
  delete from public.shot_traces where shot_id = '00000000-0000-4000-8000-777777777777';
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'An owned replay deletion was blocked'; end if;
end $$;
insert into public.shot_traces (shot_id, payload)
  values ('00000000-0000-4000-8000-777777777777', 'other user replay');
\echo PASS owned replay retries, updates, and deletion; other users remain isolated

-- Reapplying the schema with legitimate duplicate device IDs must keep rows.
reset role;
\if :legacy
  -- Model a mismatched trace allowed by the previous owner-only policy.
  -- Admin bootstrap deliberately bypasses RLS; the application role may not.
  insert into public.shot_traces (shot_id, user_id, payload)
    values ('00000000-0000-4000-8000-004294967295',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'preserved-legacy-mismatch');
\endif
\ir ../supabase/schema.sql
set local role openfloat_schema_test_client;
set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
do $$
begin
  if (select count(*) from public.shots where device_id = 'OpenFloat-BLE:test-sensor') <> 8
    or (select count(*) from public.shot_traces where payload in ('first replay', 'later replay')) <> 2 then
    raise exception 'Schema reapplication lost captures or replays';
  end if;
  if (select count(*) from pg_class where relnamespace = 'public'::regnamespace
      and relname in ('users', 'sessions', 'bow_profiles', 'shots', 'shot_traces')
      and relrowsecurity) <> 5 then
    raise exception 'An application table has lost row-level security';
  end if;
  if (select capture_kind from public.shots where id = '00000000-0000-4000-8000-333333333333') is distinct from 'hold'
    or (select capture_kind from public.shots where id = '00000000-0000-4000-8000-222222222222') is distinct from 'arrow'
    or not exists (select 1 from public.shots
      where id = '00000000-0000-4000-8000-111111111111' and capture_kind is null) then
    raise exception 'Schema reapplication changed capture types';
  end if;
end $$;
\echo PASS repeated schema application with saved captures and RLS enabled

\if :legacy
  do $$
  begin
    if not exists (select 1 from public.shots
        where id = '00000000-0000-4000-8000-999999999999'
          and device_id = 'OpenFloat-Sensor' and device_shot_id = 2147483647
          and capture_kind is null
          and timestamp = '2026-01-01T12:00:00Z' and peak_g = 22.75)
      or (select payload from public.shot_traces
          where shot_id = '00000000-0000-4000-8000-999999999999') is distinct from 'preserved-legacy-replay' then
      raise exception 'Migration changed existing capture metadata or replay';
    end if;
  end $$;
  \echo PASS legacy integer/index migration preserves metadata and replay

  set local request.jwt.claim.sub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  do $$
  declare
    changed integer;
  begin
    if (select payload from public.shot_traces
        where shot_id = '00000000-0000-4000-8000-004294967295') is distinct from 'preserved-legacy-mismatch' then
      raise exception 'Policy migration changed an existing mismatched replay';
    end if;
    begin
      update public.shot_traces set payload = 'updated mismatch'
        where shot_id = '00000000-0000-4000-8000-004294967295';
      raise exception 'An existing mismatched replay accepted an update';
    exception when insufficient_privilege then null;
    end;
    delete from public.shot_traces where shot_id = '00000000-0000-4000-8000-004294967295';
    get diagnostics changed = row_count;
    if changed <> 1 then raise exception 'The trace owner could not remove a legacy mismatch'; end if;
    if (select payload from public.shot_traces
        where shot_id = '00000000-0000-4000-8000-777777777777') is distinct from 'other user replay' then
      raise exception 'Legacy cleanup altered another replay';
    end if;
  end $$;
  \echo PASS policy migration retains legacy rows and permits owner cleanup
\endif

rollback;
\echo PASS temporary auth shim, role, captures, and schema rolled back
