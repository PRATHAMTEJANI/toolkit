-- ConvertHub AI: anonymous analytics, conversion records, and private storage buckets.
-- Apply with `supabase db push` or the Supabase SQL editor.
create extension if not exists pgcrypto;

create table if not exists public.analytics_sessions (
  session_id uuid primary key,
  visitor_id uuid not null,
  browser text,
  browser_version text,
  operating_system text,
  device_type text,
  screen_resolution text,
  language text,
  timezone text,
  country text,
  city text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  visit_time timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  session_duration integer not null default 0 check (session_duration >= 0),
  page_views integer not null default 0 check (page_views >= 0),
  tool_used text,
  files_uploaded integer not null default 0 check (files_uploaded >= 0),
  files_downloaded integer not null default 0 check (files_downloaded >= 0),
  conversion_count integer not null default 0 check (conversion_count >= 0),
  conversion_time_ms bigint,
  processing_time_ms bigint,
  errors integer not null default 0 check (errors >= 0),
  success_count integer not null default 0 check (success_count >= 0),
  success_rate numeric(5,2) not null default 100 check (success_rate between 0 and 100),
  updated_at timestamptz not null default now()
);

create index if not exists analytics_sessions_visit_time_idx on public.analytics_sessions (visit_time desc);
create index if not exists analytics_sessions_visitor_idx on public.analytics_sessions (visitor_id, visit_time desc);
create index if not exists analytics_sessions_country_idx on public.analytics_sessions (country) where country is not null;

create table if not exists public.analytics_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.analytics_sessions(session_id) on delete cascade,
  visitor_id uuid not null,
  event_type text not null check (event_type in ('page_view','tool_used','upload','download','conversion_started','conversion_succeeded','conversion_failed','conversion_cancelled','session_end')),
  tool_used text,
  format text,
  processing_time_ms bigint,
  error_code text,
  created_at timestamptz not null default now()
);

create index if not exists analytics_events_created_idx on public.analytics_events (created_at desc);
create index if not exists analytics_events_type_idx on public.analytics_events (event_type, created_at desc);

create table if not exists public.conversion_files (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.analytics_sessions(session_id) on delete cascade,
  visitor_id uuid not null,
  object_path text not null unique,
  file_name text not null,
  content_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  file_role text not null check (file_role in ('original','converted','temporary')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '1 day'),
  deleted_at timestamptz
);
create index if not exists conversion_files_session_idx on public.conversion_files (session_id, created_at desc);
create index if not exists conversion_files_expiry_idx on public.conversion_files (expires_at) where deleted_at is null;

create table if not exists public.conversion_jobs (
  id uuid primary key,
  session_id uuid not null references public.analytics_sessions(session_id) on delete cascade,
  visitor_id uuid not null,
  tool text not null,
  source_path text not null,
  source_paths text[] not null default '{}',
  options jsonb not null default '{}'::jsonb,
  result_path text,
  source_format text,
  target_format text not null,
  status text not null default 'queued' check (status in ('queued','active','completed','failed','cancelled')),
  progress integer not null default 0 check (progress between 0 and 100),
  attempts integer not null default 0,
  processing_time_ms bigint,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists conversion_jobs_created_idx on public.conversion_jobs (created_at desc);
create index if not exists conversion_jobs_status_idx on public.conversion_jobs (status, created_at desc);

-- Service role only. Anonymous browser requests use server APIs and never receive this key.
alter table public.analytics_sessions enable row level security;
alter table public.analytics_events enable row level security;
alter table public.conversion_files enable row level security;
alter table public.conversion_jobs enable row level security;
revoke all on public.analytics_sessions, public.analytics_events, public.conversion_files, public.conversion_jobs from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('originals', 'originals', false, 104857600, array['application/pdf','image/jpeg','image/png','image/webp','image/gif','image/svg+xml','image/heic','image/heif','video/mp4','video/webm','video/quicktime','audio/mpeg','audio/wav','audio/aac','audio/ogg','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/msword','application/vnd.ms-excel','application/vnd.ms-powerpoint']),
  ('converted', 'converted', false, 104857600, null),
  ('temporary', 'temporary', false, 104857600, null)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- No public object policies: signed upload/download tokens are minted by the server service role.
