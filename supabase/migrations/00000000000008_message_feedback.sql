-- Sub-projeto 9: per-trace user feedback (👍/👎 + optional comment).
-- Anchored on the Langfuse trace_id (one per chat.turn) rather than message_id
-- because /api/chat does not persist message ids in the JSONB messages column.

create table message_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references sessions(id) on delete cascade,
  trace_id text not null,
  rating text not null check (rating in ('up','down')),
  comment text check (length(comment) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, trace_id)
);

create index message_feedback_lookup
  on message_feedback(user_id, session_id, created_at desc);

alter table message_feedback enable row level security;

create policy mf_select_own on message_feedback
  for select using (auth.uid() = user_id);
create policy mf_insert_own on message_feedback
  for insert with check (auth.uid() = user_id);
create policy mf_update_own on message_feedback
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy mf_delete_own on message_feedback
  for delete using (auth.uid() = user_id);
