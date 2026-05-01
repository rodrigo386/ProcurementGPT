# Spec: Sub-projeto 1 — Fundação (ProcurementGPT)

**Data:** 2026-05-01
**Sub-projeto:** 1 de 7
**Status:** Aprovado para implementação

## Contexto

ProcurementGPT é um chatbot RAG especialista em teorias de procurement, produto da IAgentics. O sistema completo foi decomposto em 7 sub-projetos. Este é o primeiro: a fundação sobre a qual os demais serão construídos.

Sub-projetos da decomposição (referência):
1. **Fundação** ← este
2. Pipeline de ingestão (Python)
3. Camada RAG (retriever híbrido + rerank + classifier)
4. API de chat com streaming SSE
5. UI de chat (Next.js + shadcn + branding IAgentics)
6. Admin + Auth + LGPD
7. Observabilidade Langfuse + evals

## Objetivo

Entregar um scaffold mínimo navegável que satisfaça simultaneamente:

- App Next.js 14 inicia e renderiza landing temporária
- Supabase Cloud conectado, schema com pgvector aplicado
- Todas as integrações externas (Google Generative AI, Voyage, Cohere) testáveis via health check
- Type-safety estrita configurada
- Convenções de pasta, branding e env vars que os 6 sub-projetos seguintes vão estender

Não-objetivos (delegados a sub-projetos posteriores): retrieval, ingestão, chat, UI completa, auth, RLS real, observabilidade, evals.

## Stack desta fase

- Next.js 14 App Router + TypeScript strict
- Tailwind + shadcn/ui (inicializado, sem componentes específicos)
- next-themes (tema light/dark)
- Inter via `next/font/google`
- Supabase Cloud (Postgres + pgvector + pg_trgm)
- Supabase CLI para migrations
- Google Generative AI SDK (@google/genai)
- Voyage AI HTTP client (sem SDK oficial Node)
- Cohere HTTP client (rerank-multilingual-v3.0)

## Estrutura de pastas

```
IACompras/
├─ app/
│  ├─ layout.tsx                 (root + Inter + ThemeProvider)
│  ├─ page.tsx                   (landing temporária)
│  ├─ globals.css                (Tailwind + CSS vars de tema)
│  └─ api/
│     └─ health/
│        └─ route.ts             (Edge runtime)
├─ lib/
│  ├─ db/
│  │  └─ supabase.ts             (createClient browser + server)
│  └─ llm/
│     ├─ gemini.ts               (Google GenAI wrapper, lazy init)
│     ├─ voyage.ts               (HTTP client embeddings)
│     └─ cohere.ts               (HTTP client rerank)
├─ supabase/
│  ├─ config.toml                (Supabase CLI config)
│  └─ migrations/
│     └─ 00000000000000_init.sql
├─ components/
│  └─ ui/                        (shadcn init - vazio)
├─ scripts/                      (vazio)
├─ public/
│  └─ logo-iagentics.svg         (placeholder)
├─ docs/
│  └─ superpowers/specs/
│     └─ 2026-05-01-fundacao-design.md
├─ .env.local.example
├─ .env.local                    (gitignored)
├─ .gitignore
├─ next.config.mjs
├─ tailwind.config.ts
├─ postcss.config.mjs
├─ tsconfig.json                 (strict + noUncheckedIndexedAccess)
├─ eslint.config.mjs
├─ .prettierrc.json
├─ package.json
└─ CLAUDE.md
```

## Schema Supabase (migration `00000000000000_init.sql`)

```sql
-- Extensões
create extension if not exists vector;
create extension if not exists pg_trgm;

-- Tabelas core
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

create table conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  created_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  citations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- RLS habilitado mas sem políticas — políticas reais no sub-projeto 6 (Auth)
alter table articles enable row level security;
alter table chunks enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
```

Decisão: dimensão de embedding fixada em 1024 (voyage-3-large). Mudar de modelo no futuro implica nova migration + reprocessamento.

Decisão: `tsv` é coluna gerada (`generated always as ... stored`) com configuração `portuguese`. PT-BR é a língua primária. Artigos em inglês (`language='en'`) ainda serão indexados nessa configuração — perda aceitável; se virar gargalo, sub-projeto 3 pode adicionar coluna `tsv_en` adicional.

Decisão: RLS habilitado em todas as tabelas mas sem políticas. Significa que apenas a service-role key pode ler/escrever na Fundação. Isso é proposital — força que sub-projetos posteriores definam políticas explícitas em vez de vazar dados por engano.

## `.env.local.example`

```
# Google Generative AI
GOOGLE_API_KEY=
GEMINI_MODEL=gemini-3.1-flash-lite-preview

# Voyage AI
VOYAGE_API_KEY=
VOYAGE_MODEL=voyage-3-large

# Cohere
COHERE_API_KEY=
COHERE_RERANK_MODEL=rerank-multilingual-v3.0

# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Langfuse (consumido só no sub-projeto 7; pode ficar vazio na Fundação)
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

Nota sobre `GEMINI_MODEL`: o ID exato (ex: `gemini-3.1-flash` vs `gemini-3.1-flash-latest`) é confirmado na implementação consultando a API do Google. O nome de variável fica genérico para permitir trocar por nova versão sem mexer em código.

## Health check `/api/health`

Edge runtime. Executa 4 pings em paralelo:

- **Supabase**: `select 1` via service-role client
- **Voyage**: `POST /v1/embeddings` com input `["hello"]`, model `voyage-3-large`
- **Cohere**: `POST /v2/rerank` com query `"a"`, documents `["b","c"]`, model `rerank-multilingual-v3.0`, top_n=1
- **Google**: `generateContent` com prompt `"ping"`, modelo `GEMINI_MODEL`, max_output_tokens 8

Resposta sucesso (200):
```json
{ "ok": true, "checks": { "supabase": "ok", "voyage": "ok", "cohere": "ok", "google": "ok" }, "ms": 412 }
```

Resposta falha (503):
```json
{ "ok": false, "checks": { "supabase": "ok", "voyage": "error: ...", ... }, "ms": 412 }
```

Não loga as chaves nem o conteúdo das respostas — só status. Usado para validar a Fundação ao final e como smoke test em sub-projetos posteriores.

## Wrappers `/lib/llm/*`

Cada arquivo expõe uma função única e tipada. Lazy init (singleton) para não criar clients em build time. Todos leem env vars; falha cedo (lança erro descritivo) se a env var estiver vazia.

- **`gemini.ts`** → `getGemini()` retorna instância do SDK. Mais funções (generate, stream) entram nos sub-projetos 3 e 4.
- **`voyage.ts`** → `embed(texts: string[]): Promise<number[][]>`. Mais funções (batch, cache) entram no sub-projeto 2.
- **`cohere.ts`** → `rerank(query: string, documents: string[], topN: number)`. Consumido pelo sub-projeto 3.

Na Fundação, esses wrappers só precisam ser suficientes para o `/api/health` funcionar. A interface fica pequena de propósito.

## `/lib/db/supabase.ts`

Duas funções:

- `getServerSupabase()` — usa `SUPABASE_SERVICE_ROLE_KEY`, para uso em rotas API e scripts. Bypassa RLS.
- `getBrowserSupabase()` — usa `NEXT_PUBLIC_SUPABASE_ANON_KEY`, para client components. Respeita RLS (que ainda não tem políticas — então só lê o que for liberado nos sub-projetos posteriores).

Ambas singletons. Tipos do banco gerados via `supabase gen types typescript` ficam em `lib/db/database.types.ts` (gerado, não comitado se for um workflow — comitado nesta fase pra simplicidade).

## Configurações de tooling

**`tsconfig.json`** — `strict: true`, `noUncheckedIndexedAccess: true`, `target: "ES2022"`, paths `@/*` → `./*`.

**`tailwind.config.ts`** — content padrão Next, plugin `tailwindcss-animate`, CSS vars de tema (background, foreground, primary, etc.) com `--primary: 217 100% 50%` (#0066ff em HSL).

**`next-themes`** — `ThemeProvider` no `app/layout.tsx`, `attribute="class"`, `defaultTheme="system"`.

**`next.config.mjs`** — vazio inicialmente; em sub-projetos posteriores ganha config de imagens, headers etc.

**ESLint** — config flat (`eslint.config.mjs`) com Next.js recomendado + TS recomendado. Sem regras agressivas.

**Prettier** — `.prettierrc.json` mínimo (semi: true, singleQuote: true, trailingComma: 'all').

## Comandos `package.json`

- `npm run dev` — `next dev`
- `npm run build` — `next build`
- `npm run start` — `next start`
- `npm run lint` — `next lint`
- `npm run typecheck` — `tsc --noEmit`
- `npm run db:migrate` — `supabase db push`
- `npm run db:types` — `supabase gen types typescript --linked > lib/db/database.types.ts`

Comandos `ingest.py` e `eval` aparecem nos sub-projetos 2 e 7.

## Branding

- Logo placeholder em `public/logo-iagentics.svg` (texto simples até receber asset real)
- Cor primária `#0066ff` como CSS var no Tailwind
- Tipografia Inter via `next/font/google` no root layout
- Footer da landing temporária com link para `https://www.iagentics.com.br`

Nada de "ProAICircle" em lugar nenhum.

## Critérios de sucesso (verificáveis)

1. `npm install` completa sem erros
2. `npm run typecheck` retorna 0
3. `npm run lint` retorna 0
4. `npm run build` completa sem erros
5. `npm run db:migrate` aplica a migration no Supabase Cloud (smoke test: `\dt` lista as 4 tabelas)
6. `npm run dev` + `curl localhost:3000` → 200, HTML da landing renderiza
7. `curl localhost:3000/api/health` → 200, JSON com 4 "ok"
8. `.env.local` está no `.gitignore`; `.env.local.example` versionado
9. `tree` mostra estrutura idêntica à descrita em "Estrutura de pastas"

## Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| ID exato do modelo Gemini 3.1 Flash não validado | `GEMINI_MODEL` é env var; resolver na implementação consultando a API |
| Voyage não tem SDK Node oficial — depende de fetch HTTP | Wrapper `lib/llm/voyage.ts` tipa a resposta; testes via /api/health pegam regressões cedo |
| pgvector na conta Supabase Cloud pode não estar habilitado por padrão em todos os planos | Migration usa `create extension if not exists`; falha cedo com erro claro se o plano não suportar |
| Edge runtime tem limites de bundle e APIs disponíveis | Health check é leve; wrappers HTTP são compatíveis com Edge. Quando isso virar problema (sub-projeto 4 ou 5) reavaliamos |

## Fora de escopo

- Streaming SSE / endpoint de chat (sub-projeto 4)
- Componentes de UI específicos (sub-projeto 5)
- Pipeline Python de ingestão (sub-projeto 2)
- Lógica RAG, retriever híbrido, classifier, prompt-builder (sub-projeto 3)
- Auth, RLS real, opt-in LGPD (sub-projeto 6)
- Langfuse, evals, golden set (sub-projeto 7)
- Logo IAgentics final (placeholder por enquanto)
- Deploy / CI / CD (não é parte desta decomposição inicial)
