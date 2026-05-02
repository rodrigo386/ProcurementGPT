-- Sub-projeto 6a: profiles table, RLS policies, admin role helper.

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'user' check (role in ('user', 'admin')),
  display_name text,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

-- Helper to check admin role without triggering RLS recursion on profiles
create or replace function is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select role = 'admin' from profiles where id = auth.uid()), false);
$$;

-- Profiles policies
create policy profiles_self_read on profiles for select to authenticated
  using (id = auth.uid());
create policy profiles_self_update on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_admin_read on profiles for select to authenticated
  using (is_admin());

-- Auto-create profile when an auth.users row is inserted
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- articles + chunks: authenticated users can read; mutations stay service-role
create policy articles_authenticated_read on articles for select to authenticated using (true);
create policy chunks_authenticated_read on chunks for select to authenticated using (true);

grant execute on function is_admin() to anon, authenticated, service_role;
