-- Forward-fix for environments that applied migration 0004 before the
-- default auth.uid() was added. The browser hook's `insert({})` fails RLS
-- (with check user_id = auth.uid()) without a column default that fills in
-- the JWT's auth.uid(). Idempotent — re-running is safe.
alter table public.sessions alter column user_id set default auth.uid();
