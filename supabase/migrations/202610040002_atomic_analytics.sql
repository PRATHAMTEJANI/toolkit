-- Record each anonymous event and update its session counters in one transaction.
-- This prevents concurrent upload/page-view events from overwriting one another.
create or replace function public.record_anonymous_analytics(
  p_event jsonb,
  p_browser text,
  p_browser_version text,
  p_operating_system text,
  p_device_type text,
  p_screen_resolution text,
  p_language text,
  p_timezone text,
  p_country text,
  p_city text,
  p_referrer text,
  p_utm_source text,
  p_utm_medium text,
  p_utm_campaign text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_session_id uuid := (p_event->>'sessionId')::uuid;
  v_visitor_id uuid := (p_event->>'visitorId')::uuid;
  v_event_type text := p_event->>'eventType';
  v_page_views integer := case when v_event_type = 'page_view' then 1 else 0 end;
  v_uploads integer := case when v_event_type = 'upload' then 1 else 0 end;
  v_downloads integer := case when v_event_type = 'download' then 1 else 0 end;
  v_successes integer := case when v_event_type = 'conversion_succeeded' then 1 else 0 end;
  v_errors integer := case when v_event_type = 'conversion_failed' then 1 else 0 end;
  v_affected integer;
begin
  if v_event_type not in ('page_view','tool_used','upload','download','conversion_started','conversion_succeeded','conversion_failed','session_end') then
    raise exception 'Unsupported analytics event';
  end if;

  insert into public.analytics_sessions as current_session (
    session_id, visitor_id, browser, browser_version, operating_system, device_type,
    screen_resolution, language, timezone, country, city, referrer, utm_source,
    utm_medium, utm_campaign, last_seen_at, session_duration, page_views,
    tool_used, files_uploaded, files_downloaded, conversion_count, errors,
    success_count, success_rate, conversion_time_ms, processing_time_ms, updated_at
  ) values (
    v_session_id, v_visitor_id, p_browser, p_browser_version, p_operating_system,
    p_device_type, p_screen_resolution, p_language, p_timezone, p_country, p_city,
    p_referrer, p_utm_source, p_utm_medium, p_utm_campaign, now(),
    greatest(0, coalesce((p_event->>'durationSeconds')::integer, 0)), v_page_views,
    p_event->>'toolUsed', v_uploads, v_downloads, v_successes, v_errors,
    v_successes, case when v_successes + v_errors > 0 then v_successes::numeric / (v_successes + v_errors) * 100 else 100 end,
    nullif(p_event->>'processingTimeMs', '')::bigint,
    nullif(p_event->>'processingTimeMs', '')::bigint, now()
  )
  on conflict (session_id) do update set
    browser = coalesce(current_session.browser, excluded.browser),
    browser_version = coalesce(current_session.browser_version, excluded.browser_version),
    operating_system = coalesce(current_session.operating_system, excluded.operating_system),
    device_type = coalesce(current_session.device_type, excluded.device_type),
    screen_resolution = coalesce(current_session.screen_resolution, excluded.screen_resolution),
    language = coalesce(current_session.language, excluded.language),
    timezone = coalesce(current_session.timezone, excluded.timezone),
    country = coalesce(current_session.country, excluded.country),
    city = coalesce(current_session.city, excluded.city),
    referrer = coalesce(current_session.referrer, excluded.referrer),
    utm_source = coalesce(current_session.utm_source, excluded.utm_source),
    utm_medium = coalesce(current_session.utm_medium, excluded.utm_medium),
    utm_campaign = coalesce(current_session.utm_campaign, excluded.utm_campaign),
    last_seen_at = now(),
    session_duration = greatest(current_session.session_duration, excluded.session_duration),
    page_views = current_session.page_views + excluded.page_views,
    tool_used = coalesce(excluded.tool_used, current_session.tool_used),
    files_uploaded = current_session.files_uploaded + excluded.files_uploaded,
    files_downloaded = current_session.files_downloaded + excluded.files_downloaded,
    conversion_count = current_session.conversion_count + excluded.conversion_count,
    errors = current_session.errors + excluded.errors,
    success_count = current_session.success_count + excluded.success_count,
    success_rate = case
      when current_session.success_count + current_session.errors + excluded.success_count + excluded.errors > 0
      then (current_session.success_count + excluded.success_count)::numeric * 100 /
        (current_session.success_count + current_session.errors + excluded.success_count + excluded.errors)
      else 100 end,
    conversion_time_ms = coalesce(excluded.conversion_time_ms, current_session.conversion_time_ms),
    processing_time_ms = coalesce(excluded.processing_time_ms, current_session.processing_time_ms),
    updated_at = now()
  where current_session.visitor_id = excluded.visitor_id;

  get diagnostics v_affected = row_count;
  if v_affected = 0 then raise exception 'Session does not match visitor'; end if;

  insert into public.analytics_events (
    session_id, visitor_id, event_type, tool_used, format, processing_time_ms, error_code
  ) values (
    v_session_id, v_visitor_id, v_event_type, p_event->>'toolUsed', p_event->>'format',
    nullif(p_event->>'processingTimeMs', '')::bigint, p_event->>'errorCode'
  );
end;
$$;

revoke all on function public.record_anonymous_analytics(jsonb,text,text,text,text,text,text,text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.record_anonymous_analytics(jsonb,text,text,text,text,text,text,text,text,text,text,text,text,text) to service_role;

-- Keep the dashboard's headline totals exact without loading unbounded tables
-- into a serverless route. Detail lists remain intentionally small and recent.
create index if not exists conversion_jobs_finished_idx
  on public.conversion_jobs (finished_at desc)
  where status in ('completed', 'failed');

create or replace function public.get_admin_analytics_overview()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  with totals as (
    select
      (select count(distinct visitor_id) from public.analytics_sessions) as visitors,
      (select count(distinct visitor_id) from public.analytics_sessions where last_seen_at >= now() - interval '15 minutes') as active_users,
      (select count(distinct visitor_id) from public.analytics_sessions where (visit_time at time zone 'UTC')::date = (now() at time zone 'UTC')::date) as visitors_today,
      (select count(distinct visitor_id) from public.analytics_sessions where date_trunc('month', visit_time at time zone 'UTC') = date_trunc('month', now() at time zone 'UTC')) as visitors_this_month,
      (select count(distinct country) from public.analytics_sessions where country is not null) as countries,
      (select count(distinct city) from public.analytics_sessions where city is not null) as cities,
      (select count(*) from public.analytics_events where event_type = 'upload') as uploads,
      (select count(*) from public.analytics_events where event_type = 'download') as downloads,
      (select count(*) from public.conversion_jobs where status = 'completed') as conversions,
      (select count(*) from public.conversion_jobs where status = 'failed') as errors,
      (select coalesce(sum(size_bytes), 0) from public.conversion_files where deleted_at is null) as stored_bytes,
      (select count(*) from public.conversion_files where deleted_at is null and file_role = 'original') as stored_originals
  ), days as (
    select (date_trunc('day', now() at time zone 'UTC')::date - n)::date as day
    from generate_series(13, 0, -1) as deltas(n)
  )
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
      'visitors', visitors, 'activeUsers', active_users, 'visitorsToday', visitors_today,
      'visitorsThisMonth', visitors_this_month, 'countries', countries, 'cities', cities,
      'uploads', uploads, 'downloads', downloads, 'conversions', conversions, 'errors', errors,
      'successRate', case when conversions + errors > 0 then round(conversions::numeric * 100 / (conversions + errors))::integer else 0 end,
      'storedBytes', stored_bytes, 'storedOriginals', stored_originals
    ) from totals),
    'breakdowns', jsonb_build_object(
      'countries', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'count', count) order by count desc), '[]'::jsonb) from (select country as name, count(*) as count from public.analytics_sessions where country is not null group by country order by count desc limit 12) q),
      'cities', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'count', count) order by count desc), '[]'::jsonb) from (select city as name, count(*) as count from public.analytics_sessions where city is not null group by city order by count desc limit 12) q),
      'browsers', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'count', count) order by count desc), '[]'::jsonb) from (select browser as name, count(*) as count from public.analytics_sessions where browser is not null group by browser order by count desc limit 12) q),
      'devices', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'count', count) order by count desc), '[]'::jsonb) from (select device_type as name, count(*) as count from public.analytics_sessions where device_type is not null group by device_type order by count desc limit 12) q),
      'operatingSystems', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'count', count) order by count desc), '[]'::jsonb) from (select operating_system as name, count(*) as count from public.analytics_sessions where operating_system is not null group by operating_system order by count desc limit 12) q),
      'tools', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'count', count) order by count desc), '[]'::jsonb) from (select tool as name, count(*) as count from public.conversion_jobs group by tool order by count desc limit 12) q),
      'formats', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'count', count) order by count desc), '[]'::jsonb) from (select target_format as name, count(*) as count from public.conversion_jobs where status = 'completed' group by target_format order by count desc limit 12) q)
    ),
    'chart', (select coalesce(jsonb_agg(jsonb_build_object(
      'date', to_char(days.day, 'YYYY-MM-DD'),
      'visitors', (select count(distinct s.visitor_id) from public.analytics_sessions s where (s.visit_time at time zone 'UTC')::date = days.day),
      'conversions', (select count(*) from public.conversion_jobs j where j.status = 'completed' and (j.finished_at at time zone 'UTC')::date = days.day),
      'errors', (select count(*) from public.conversion_jobs j where j.status = 'failed' and (j.finished_at at time zone 'UTC')::date = days.day)
    ) order by days.day), '[]'::jsonb) from days),
    'logs', (select coalesce(jsonb_agg(jsonb_build_object('at', created_at, 'type', event_type, 'tool', tool_used, 'format', format, 'error', error_code) order by created_at desc), '[]'::jsonb) from (select created_at, event_type, tool_used, format, error_code from public.analytics_events order by created_at desc limit 30) recent_events),
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'status', status, 'tool', tool, 'target_format', target_format, 'error_code', error_code, 'created_at', created_at) order by created_at desc), '[]'::jsonb) from (select id, status, tool, target_format, error_code, created_at from public.conversion_jobs order by created_at desc limit 30) recent_jobs)
  );
$$;

revoke all on function public.get_admin_analytics_overview() from public, anon, authenticated;
grant execute on function public.get_admin_analytics_overview() to service_role;
