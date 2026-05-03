-- Sub-projeto 6c: admin UI + browser ingestion

-- 6c.1 — ingestion_jobs (browser-driven ingest pipeline state)
create table ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  filename text not null,
  storage_path text not null,
  size_bytes bigint not null,
  mime_type text not null,
  status text not null default 'queued'
    check (status in ('queued','running','done','error')),
  stage text,
  progress smallint not null default 0,
  chunks_count int,
  article_id uuid references articles(id) on delete set null,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create index ingestion_jobs_user_status_created_idx
  on ingestion_jobs (user_id, status, created_at desc);

alter table ingestion_jobs enable row level security;

create policy ingestion_jobs_admin_select on ingestion_jobs for select to authenticated
  using (is_admin());
create policy ingestion_jobs_admin_insert on ingestion_jobs for insert to authenticated
  with check (is_admin() and user_id = auth.uid());
create policy ingestion_jobs_admin_update on ingestion_jobs for update to authenticated
  using (is_admin()) with check (is_admin());
create policy ingestion_jobs_admin_delete on ingestion_jobs for delete to authenticated
  using (is_admin());

-- 6c.2 — profiles: admins can update role
create policy profiles_admin_update on profiles for update to authenticated
  using (is_admin()) with check (is_admin());

-- 6c.3 — articles: admins can delete (chunks cascade via existing FK)
create policy articles_admin_delete on articles for delete to authenticated
  using (is_admin());

-- 6c.4 — admin view of profiles + auth.users.email
create or replace view profiles_with_email
with (security_invoker = true) as
  select p.id, p.role, p.display_name, p.created_at,
         u.email, u.last_sign_in_at, u.created_at as auth_created_at
    from profiles p
    join auth.users u on u.id = p.id;

grant select on profiles_with_email to authenticated;

-- 6c.5 — sessions count helper (callable by authenticated; admin gate is in API layer)
create or replace function admin_user_session_counts()
returns table (user_id uuid, session_count bigint)
language sql
security definer
set search_path = public
stable
as $$
  select user_id, count(*)::bigint from sessions group by user_id;
$$;
revoke all on function admin_user_session_counts() from public;
grant execute on function admin_user_session_counts() to authenticated;
