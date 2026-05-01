-- ProcurementGPT initial schema (sub-projeto 1: Fundação)
-- Extensions
create extension if not exists vector;
create extension if not exists pg_trgm;

-- Articles
create table articles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  author text,
  source_url text,
  language text not null default 'pt',
  published_at date,
  ingested_at timestamptz not null default now(),
  raw_md text not null,
  metadata jsonb not null default '{}'::jsonb
);

-- Chunks (1024 dims = voyage-3-large)
create table chunks (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references articles(id) on delete cascade,
  ord int not null,
  content text not null,
  embedding vector(1024),
  tsv tsvector generated always as (to_tsvector('portuguese', content)) stored,
  metadata jsonb not null default '{}'::jsonb
);

create index chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
create index chunks_tsv_idx on chunks using gin (tsv);
create index chunks_article_idx on chunks(article_id);

-- Conversations
create table conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  created_at timestamptz not null default now()
);

-- Messages
create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  citations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- RLS habilitado, políticas reais virão no sub-projeto 6 (Auth)
alter table articles enable row level security;
alter table chunks enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
