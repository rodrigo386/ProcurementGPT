# Projeto: ProcurementGPT — Especialista em Teorias de Compras

## Contexto
Chatbot especialista treinado em centenas de artigos sobre teorias, frameworks e práticas
de procurement. Empresa proprietária do produto **a definir** (não usar IAgentics — referência
removida em 2026-05-02). Audiência: gestores de compras brasileiros (PT-BR primário, EN secundário).

## Stack obrigatória
- Next.js 14 App Router + TypeScript strict
- Tailwind + shadcn/ui (tema light/dark via `next-themes`)
- Supabase (Postgres + pgvector + Auth + Storage)
- Google Generative AI SDK (`@google/genai`) — Gemini 3.1 Flash Lite (preview) para classificação, condenser e geração one-shot
- Vercel AI SDK (`ai` v4 + `@ai-sdk/google`) — para o streaming SSE do endpoint de chat
- Voyage AI para embeddings (`voyage-3-large`, 1024 dims)
- Cohere Rerank 3 para reranking
- Langfuse para observabilidade (sub-projeto 7)

## Princípios não-negociáveis
1. **Retrieval híbrido obrigatório** — vetorial + lexical (FTS portuguese) + RRF + Cohere rerank, nunca só cosine
2. **Resposta fundamentada na base** — o contexto recuperado é injetado no prompt para fundamentar a resposta; o modelo NÃO menciona fontes, IDs, ou números entre colchetes para o usuário (decisão 2026-05-02). Sem fonte na base, dizer explicitamente "não tenho fonte sobre isso"
3. **Streaming SSE** — resposta começa a aparecer em <3s
4. **Node runtime em `/api/chat`** (era Edge até sub-projeto 6; trocou em sub-projeto 7 porque a SDK do Langfuse usa APIs Node — `crypto`, `fs` — que falham silenciosamente no Edge e perdem traces). Outras rotas Edge quando possível; ingestão Python em Node.
5. **LGPD compliance** — logs sem PII, opt-in para histórico (sub-projeto 6); Langfuse usa Supabase UUID pseudonimizado como `userId`, nunca email
6. **Custos sob controle** — cache de embeddings, Gemini Flash Lite para todas as chamadas LLM
7. **Observabilidade obrigatória** — `/api/chat` abre uma Langfuse trace por turno; cada estágio do RAG é um span. Sem isto, retrieval e prompt iteram às cegas

## Status — sub-projetos completos

| # | Tag | Entrega |
|---|---|---|
| 1 | `fundacao-complete` | Schema (`articles`, `chunks` com `vector(1024)` + `tsv` portuguese FTS), wrappers Node (gemini, voyage, cohere, supabase), `/api/health` Edge route, theme provider, env loader |
| 2 | `ingestao-complete` | `scripts/ingest.py` CLI: discover → parse (unstructured) → hybrid chunk → metadata (title/author/lang/date) → SHA-256 idempotência → Voyage embed → psycopg insert. `--dry-run`, `--force`, `--cache`. 23 pytest. Migration 0001 (`articles_content_hash_idx`) |
| 3 | `retrieval-complete` | `runRag(query) → { classification, sources, system, user, debug }`. classifier (Gemini Flash JSON) + retriever (vector RPC + FTS RPC + RRF) + reranker (Cohere) + prompt-builder + condenser. CLI `rag:query`, eval `rag:eval` (recall@5=1.00 inicial). Migration 0002 (RPCs `match_chunks`, `search_chunks_fts`) |
| 4 | `chat-complete` | `POST /api/chat` Edge SSE via Vercel AI SDK + `@ai-sdk/google`. Stateless. Multi-turn condenser. Sources annotation no stream (não exibida no UI) |
| 5 | `chat-ui-complete` | `/chat` SPA cliente: split-pane sidebar + ChatRoot/ChatSession (key remount), markdown rendering, theme toggle (system/light/dark), mobile drawer, hero + 4 suggestion cards, Composer (Enter sends, Stop button) |
| 6a | `auth-rls-complete` | Supabase Auth invite-only (email/senha + Google OAuth). `middleware.ts` gates `/chat` + `/admin`. Páginas: `/login`, `/forgot-password`, `/reset-password`, `/auth/callback`. `lib/auth.ts` (getCurrentUser/requireUser/getProfile). `UserRow` no rodapé do sidebar. Migration 0003 (`profiles` + RLS + `is_admin()` + trigger) |
| 6b | `conversation-persistence-complete` | DB-only conversation history (localStorage retired for authed). `useChatSessionsRemote` drop-in for `useChatSessions`. Migration 0004 (`sessions` table com 4 RLS owner-only policies, FK cascade para LGPD erasure mecânica) |
| 6c | `admin-ui-complete` | `/admin` (sidebar + sub-routes `/admin/{users,articles,ingest}`) gated por `requireAdmin()` → 404 (não 403) para non-admins. Port TS da pipeline de ingest (`pdf-parse@1.1.1` + `mammoth` + chunker/metadata/parser/pipeline) roda como Node route via fire-and-forget + 2s polling, sobrevive ao fechamento da aba. Migration 0005: `ingestion_jobs` + RLS, `profiles_with_email` view, `admin_user_session_counts()` RPC, `profiles_admin_update`/`articles_admin_delete` policies. Storage bucket `ingest-uploads` com policy admin-only path-scoped. Auto-cleanup de jobs `done` > 7d inline no `/jobs`. UserRow mostra link "Admin" só para admins |
| 7 | `langfuse-eval-complete` | Langfuse instrumentation em `/api/chat` (Edge): trace `chat.turn` por turno com 6 spans aninhados (condense, classify, retrieve, rerank, build-prompt, generate), `userId` = Supabase UUID, `sessionId` = sessions.id, flush em onFinish/error/abort. Wrapper `lib/observability/langfuse.ts` com no-op fallback quando keys ausentes. Eval expandido para 25 pares (5 ângulos × 4 artigos + 2 smalltalk + 3 comparison) com batched embed (1 chamada Voyage para todas as queries). CI workflow GitHub Actions roda typecheck + vitest + pytest + rag:eval em PR + push para main, falha se `recall@5 < 0.85`. Eval traces tagged `env:ci` agrupados em sessão por commit. Baseline atual: recall@5 = 1.00 (18/18 scoreable na corpus de 4 artigos). |
| 8 | `beta-hardening-complete` | Per-user rate limit em `/api/chat` (10/min, 60/h) via Postgres RPC `check_rate_limit` + tabela `rate_limit_events` (migration 0007, RLS sem policies, RPC security definer com cleanup probabilístico). Auth obrigatório em `/api/chat` (401 sem cookie). Threshold `MIN_RELEVANCE = 0.10` no reranker — chunks abaixo são descartados, prompt-builder cai no `REFUSAL_INSTRUCTION`. Tag dinâmica `env:${APP_ENV}` no trace (default `production`). Span `rerank` ganha `top1Score`; trace ganha tag `low-confidence` quando threshold zera tudo. `sonner` Toaster no root layout; `ChatSession` mostra toast amigável em 429 (lê `retry_after_secs`) e 500. `ChatErrorBoundary` envolvendo `<ChatSession/>`. Checklist manual em `docs/product/beta-smoke-test.md`. |
| 9 | `feedback-loop-complete` | 👍/👎 inline em cada resposta do assistant via `<MessageActions/>` (lucide ThumbsUp/ThumbsDown), 👎 expande textarea inline para comentário (≤1000 chars). Migration 0008: `message_feedback` + 4 RLS owner-only policies + `unique(user_id, trace_id)` para upsert flip. `Trace.id` exposto pelo wrapper Langfuse (real ou `crypto.randomUUID()` em no-op). `/api/chat` adiciona `traceId` à message annotation; client passa de volta em `POST /api/feedback` (Node, zod-validated, 401/400/404/500/204). `lib/feedback.recordFeedback` UPSERTa + chama `scoreTrace` fire-and-forget (`name: user-feedback`, `value: 1` ou `-1`). `useChatSessionsRemote` hidrata `ratings: Map<traceId, rating>` ao trocar sessão. Header ganha link mailto "Feedback geral" (hardcoded até decidir branding). |

**Milestone 1 closed.**

## Milestone 2 — Beta Readiness (em planejamento, 2026-05-03)
Objetivo: abrir beta fechado (3–5 gestores convidados) para coletar traces reais no Langfuse e escopar Milestone 3 (B2B) com dados, não com palpite. Single-tenant deliberadamente.

- **8 — beta-hardening** ✅ completo (`beta-hardening-complete`)
- **9 — feedback-loop** ✅ completo (`feedback-loop-complete`)

Milestone 2 entregue. Critério de saída para Milestone 3 (≥100 traces `env:beta` com ≥30 ratings em ≥2 semanas) começa a contar a partir do primeiro convite de beta.

Roadmap completo em `docs/product/beta-readiness.md`. Roadmap B2B (Milestone 3+) em `docs/product/b2b-roadmap.md`.

**Test count atual:** 143 vitest, 23 pytest, typecheck zero erros. CI gate: `recall@5 ≥ 0.85` em PR + push main.

## Estrutura de pastas
```
/app
  page.tsx                              (landing pública: nome do produto + botão Entrar)
  layout.tsx                            (root layout, theme provider)
  globals.css                           (HSL CSS variables, --primary = brand color)
  /api
    /chat/route.ts                      (streaming SSE, Edge, AI SDK)
    /health/route.ts                    (smoke check, Edge)
  /chat/page.tsx                        (UI principal, mounts <ChatRoot/>, gated by middleware)
  /login/page.tsx                       (LoginForm: email/senha + Google OAuth + esqueci senha)
  /forgot-password/page.tsx             (reset link request)
  /reset-password/page.tsx              (set new password)
  /auth/callback/route.ts               (PKCE code exchange)
  /admin
    layout.tsx                          (requireAdmin → 404; sidebar shell)
    page.tsx                            (redirect to /admin/users)
    /users/page.tsx                     (server: profiles_with_email + admin_user_session_counts → <UsersTable/>)
    /articles/page.tsx                  (mounts <ArticlesSplitView/>)
    /ingest/page.tsx                    (mounts <IngestRoot/>)
  /api/admin
    /users/route.ts                     (Node: GET list, POST invite, PATCH role)
    /articles/[id]/route.ts             (Node: DELETE, chunks cascade)
    /ingest/upload/route.ts             (Node: multipart → Storage + job row)
    /ingest/run/[jobId]/route.ts        (Node, maxDuration=300: runs runPipeline)
    /ingest/jobs/route.ts               (Node: GET list, inline cleanup + stale sweep)
    /ingest/retry/[jobId]/route.ts      (Node, maxDuration=300: reset error → re-run)
/lib
  /rag
    types.ts                            (Classification, RetrievedChunk, SourceRef, ChatMessage, RagResult)
    classifier.ts                       (Gemini Flash: teoria, intenção, idioma)
    retriever.ts                        (vetorial + FTS via RPC, RRF)
    reranker.ts                         (Cohere wrapper, fallback para RRF)
    prompt-builder.ts                   (system prompt + contexto fundamentador, SEM citações)
    condenser.ts                        (multi-turn → standalone query)
    index.ts                            (runRag orquestrador)
  /db
    supabase.ts                         (service-role + anon clients)
    supabase-browser.ts                 (cookie-aware client client; LITERAL process.env.NEXT_PUBLIC_*)
    supabase-server.ts                  (cookie-aware server client via next/headers)
  /llm
    gemini.ts                           (one-shot wrapper, @google/genai)
    voyage.ts                           (embed com inputType opcional)
    cohere.ts                           (rerank wrapper)
  /observability                        (NEW sub-projeto 7)
    types.ts                            (Trace, Span, TraceLevel)
    langfuse.ts                         (startTrace + flushAsync, no-op fallback quando keys absent)
  env.ts                                (requireEnv — server-side only; client modules use literal process.env)
  auth.ts                               (getCurrentUser, requireUser, getProfile, NotAuthenticated, requireAdmin, NotAdmin)
  chat-storage.ts                       (@deprecated; deriveTitle ainda usado)
  /db
    storage.ts                          (upload/download/delete wrappers para bucket ingest-uploads)
  /ingest                               (TS port da pipeline; scripts/ingest.py mantido como legacy)
    types.ts                            (JobStatus, JobStage, IngestJob)
    hash.ts                             (sha256 helper)
    parser.ts                           (pdf-parse@1.1.1 + mammoth + fs.readFile, <500-char OCR guard)
    chunker.ts                          (paragraph + sliding-window, MAX 3200, OVERLAP 400)
    metadata.ts                         (title/author/language/date heurísticas)
    pipeline.ts                         (runPipeline orquestrador end-to-end)
/middleware.ts                          (gates /chat + /admin via Supabase session check)
/components
  /chat (ChatRoot, ChatSession, Sidebar, Header, EmptyState, MessageList, Message, Composer)
  /auth (LoginForm, ForgotPasswordForm, ResetPasswordForm, UserRow — admin link visível só para admins)
  /admin (AdminSidebar, UsersTable, InviteUserDialog, ArticlesSplitView, ArticleDetail, ConfirmDelete, IngestRoot, Dropzone, JobCard, JobsLive, JobsRecent)
  /ui (shadcn base-nova: button, textarea, scroll-area, sheet, tooltip, dialog, input, dropdown-menu, table)
  theme-provider.tsx
/hooks
  useChatSessions.ts                    (@deprecated — localStorage; mantido para testes)
  useChatSessionsRemote.ts              (DB-backed via supabaseBrowser, drop-in para useChatSessions)
/scripts
  ingest.py                             (pipeline Python, sub-projeto 2)
  rag-query.ts                          (CLI de debug, sub-projeto 3)
  /eval
    golden.json                         (10 Q&A pairs)
    run.ts                              (recall@5, MRR, latência)
/supabase/migrations
  00000000000000_init.sql               (pgvector, FTS, articles, chunks)
  00000000000001_articles_hash_unique.sql (idempotência da ingestão)
  00000000000002_rag_rpc.sql            (match_chunks, search_chunks_fts)
  00000000000003_profiles_and_rls.sql   (profiles + is_admin() + trigger + RLS para articles/chunks)
  00000000000004_sessions.sql           (sessions table + 4 owner-only RLS policies)
  00000000000005_admin_ui.sql           (ingestion_jobs + 4 admin RLS, profiles_admin_update, articles_admin_delete, profiles_with_email view, admin_user_session_counts RPC)
  00000000000006_sessions_user_id_default.sql (forward-fix: ALTER sessions.user_id SET DEFAULT auth.uid())
/.github/workflows
  ci.yml                                (typecheck + vitest + pytest + rag:eval em PR + push main; artifact + PR comment)
/docs/superpowers
  /specs (1 design doc por sub-projeto)
  /plans (1 implementation plan por sub-projeto)
```

## Identidade visual
- **Branding TBD** — empresa proprietária ainda será criada. Não usar IAgentics, ProAICircle, ou qualquer marca específica. Produto se identifica como "ProcurementGPT".
- Cor de acento: `#0066ff` (electric blue) via CSS variable `--brand` — trocável quando a marca final for definida
- Tipografia: Inter
- Sem logo de empresa no header até decisão de branding; só nome do produto

## Comportamento do agente
Persona: "Especialista sênior em procurement com 20 anos de experiência, formação acadêmica
sólida (Kraljic, Porter, Monczka, Cox, Cousins, Dyer), didática mas direta, fundamentada na base
de conhecimento."

Estrutura padrão de resposta (sem citações visíveis):
1. Resposta direta (2-3 linhas)
2. Aprofundamento teórico baseado no contexto fornecido
3. Aplicação prática (exemplo ou caso)
4. Sugestão de leituras complementares (3 artigos da base, mencionados pelo título)

NÃO inventar teorias. Se não houver fonte na base, dizer explicitamente. NÃO mencionar IDs,
números entre colchetes, ou referências bibliográficas estilo `[1]` na resposta — é só
para o usuário ler como uma explicação fluente.

## Variáveis de ambiente
```
GOOGLE_API_KEY=
GEMINI_MODEL=gemini-3.1-flash-lite-preview
VOYAGE_API_KEY=
VOYAGE_MODEL=voyage-3-large
COHERE_API_KEY=
COHERE_RERANK_MODEL=rerank-multilingual-v3.0
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_DB_PASSWORD=          # para o ingest.py via psycopg
LANGFUSE_PUBLIC_KEY=           # ativo desde sub-projeto 7; quando vazio, wrapper retorna no-op trace
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=https://cloud.langfuse.com
APP_ENV=local                  # sub-projeto 8 — drives env:<value> tag in Langfuse (local|beta|production|ci)
```

## Comandos
- `npm run dev` — desenvolvimento Next.js
- `npm test` — vitest (TypeScript)
- `npm run typecheck` — `tsc --noEmit`
- `npm run db:migrate` — aplicar migrations Supabase via CLI (ou aplicar manualmente via psycopg/dashboard)
- `npm run rag:query "<pergunta>"` — CLI ad-hoc de retrieval
- `npm run rag:eval` — eval offline 25 pares (recall@5, MRR, latência); exit 1 se recall@5 < 0.85; escreve `scripts/eval/results.json`
- `python scripts/ingest.py --path ./artigos/` — ingerir artigos
- `python scripts/ingest.py --file <arquivo>` — ingerir 1 arquivo
- `python scripts/ingest.py --dry-run --path ./artigos/` — preview sem DB
- `scripts/.venv/Scripts/pytest.exe scripts/tests/` — testes Python

## O que evitar
- Chunking fixo por N tokens (use semantic chunking — sub-projeto 2 já entrega híbrido)
- Apenas busca vetorial (sempre híbrida + reranker)
- Mostrar `[1]`, `[2]`, IDs, ou referências bibliográficas para o usuário (decisão 2026-05-02)
- Bibliotecas pesadas no Edge Runtime
- Hardcoded prompts no componente — sempre em `/lib/rag/prompt-builder.ts`
- Reintroduzir IAgentics ou outra marca antes de o usuário decidir o nome da empresa
- Conectar a Supabase com `psycopg` sem `autocommit=True` (transações silenciosamente fazem rollback — ver memory `psycopg3_autocommit.md`)
- Em código `'use client'`, usar `requireEnv(name)` (dinâmico) para `NEXT_PUBLIC_*` — Next.js só inlina referências literais `process.env.NEXT_PUBLIC_FOO`. Use literal access em browser modules (ver `lib/db/supabase-browser.ts`)
- Usar `useChatSessions` (localStorage, deprecated) para usuários autenticados — usar `useChatSessionsRemote` (DB-backed)
- `Button asChild` do shadcn base-nova não existe — para link estilizado como botão, usar `<Link>` com classes Tailwind
- `DropdownMenuTrigger asChild` do shadcn base-nova também não existe (wraps `@base-ui/react/menu` MenuTrigger) — estilizar o trigger direto via `className`
- Restaurar localStorage de conversas após login — sub-projeto 6b decidiu **discard** (DB é a única fonte de verdade quando logado)
- `pdf-parse@2.x` tem API incompatível (class-based, depende de pdfjs-dist com workers) — fixado em `1.1.1` (default-export simples). Importar **inner path** `pdf-parse/lib/pdf-parse.js` (NÃO `pdf-parse`) — o `index.js` do pacote roda um self-test no module load que tenta ler `test/data/05-versions-space.pdf` e dispara `ENOENT`. Dinâmico ou top-level, qualquer import de `'pdf-parse'` direto vai quebrar
- Não awaitar `fetch('/api/admin/ingest/run/[jobId]')` no cliente — o ponto do padrão fire-and-forget é deixar a função do Vercel rodar até o fim mesmo após a request original retornar
- Em `/admin/*` API routes ou server components, usar `requireAdmin()` + retornar **404** (não 403) para non-admins — não revelar a existência do endpoint
- A view `profiles_with_email` foi criada com `security_invoker = true` (queries rodam como o caller). Authed users **não** têm SELECT em `auth.users`, então qualquer query do view via cookie-aware client falha com `permission denied for table users`. Usar `getServerSupabase()` (service-role) em routes admin-gated que precisam ler dela
- Bucket `ingest-uploads` é privado, com policy admin-only que restringe inserts ao próprio `auth.uid()` folder — não tentar fazer upload para outro user_id
- Chamar `runRag` em código cliente diretamente — sempre via `/api/chat` para garantir trace + auth
- Importar `langfuse` top-level em rotas Edge — usar `await import('langfuse')` dentro de `startTrace` (a wrapper já faz isso). Top-level pode quebrar Edge cold-start
- Esquecer `await flushAsync()` no `onFinish`/catch do `streamText` — Edge runtime mata a função quando a response termina, perdendo traces silenciosamente
- Pular o batching de embeds no eval — 25 chamadas seriais à Voyage seriam ~9 min (3 RPM throttle); batched é <30s
- Mudar `RECALL_THRESHOLD` em `scripts/eval/run.ts` sem atualizar a spec + CLAUDE.md (o número precisa ser auditável depois)
- Mudar `MIN_RELEVANCE` em `lib/rag/reranker.ts` sem rodar `npm run rag:eval` — o threshold é gateado por `recall@5 ≥ 0.85` e qualquer mudança precisa ser auditável
- Acessar `rate_limit_events` direto do cliente — a tabela tem RLS sem policies por design; sempre via RPC `check_rate_limit` (security definer)
- Esquecer de adicionar mocks de `@/lib/auth` + `@/lib/rate-limit` em testes novos de `/api/chat` — sem eles a route hoje retorna 401 antes de qualquer outro código rodar
- Mudar a versão de `sonner` sem confirmar que o `Toaster` continua honrando o tema do `next-themes` — o tema é resolvido em runtime via `useTheme()` no wrapper
- Persistir IDs de mensagem do `useChat` no JSONB de `sessions.messages` — sub-projeto 9 deliberadamente NÃO faz isso. O anchor de feedback é o `trace_id` Langfuse propagado via `appendMessageAnnotation`. Se um sub-projeto futuro precisar de message-level feedback (não trace-level), aí sim fazer schema change.
- Esquecer `id: 'mock-trace-id'` ao criar mocks de `Trace` em testes novos — o tipo agora exige `id: string` (sub-projeto 9). Sem isso, typecheck quebra.
- Mexer no Header sem manter o link "Feedback geral" — é o canal de fallback para reports que não cabem em 👎. O destino `mailto:rgoalves@gmail.com` é TBD-temporary; trocar quando branding definir.
- Bloquear o response do `/api/feedback` em falha do Langfuse `score()` — `recordFeedback` chama `scoreTrace` fire-and-forget de propósito; UI não deve esperar por Langfuse.

## Fluxo de chat end-to-end (sub-projetos 1-7)
```
usuário não logado → / (landing) → /login → middleware passa → /chat
                                                                 ↓
                              ChatRoot (mounted gate) → useChatSessionsRemote
                                                                 ↓
                                           supabaseBrowser ↔ Postgres sessions (RLS owner-only)
                                                                 ↓
                                              ChatSession (key=currentId) → useChat (AI SDK)
                                                                 ↓
                                          POST /api/chat (Edge) { messages, sessionId }
                                                                 ↓
                  startTrace({ name:'chat.turn', userId, sessionId, tags:['env:production'] })
                                                                 ↓
                              condense span → condenseQuery → runRag (parentTrace=trace)
                                                                 ↓
                              4 spans nested: classify → retrieve → rerank → build-prompt
                                                                 ↓
                              generate span → streamText (Gemini Flash via @ai-sdk/google)
                                                                 ↓
                                                       SSE de volta ao cliente
                                                                 ↓
              onFinish → end generate span + trace.end + await flushAsync (NÃO esquecer!)
                                                                 ↓
                                             useChatSessionsRemote.updateMessages → DB
```

## Bootstrap admin
- Único admin atual: `rgoalves@gmail.com` (auth.users id `16fab8f7-a960-48b4-903d-b590e476b51b`), role='admin' em profiles.
- Para promover outro usuário: pode usar `/admin/users` (sub-projeto 6c) — clicar no menu ⋯ da row → "Promover a admin". Ou via SQL: `update profiles set role='admin' where id=(select id from auth.users where email='<email>')`.

## Fluxo de ingestão via UI (sub-projeto 6c)
```
admin → /admin/ingest → drop PDF/DOCX/TXT no Dropzone (validação client: MIME, ≤10 MB)
                                ↓
   POST /api/admin/ingest/upload (multipart, Node) → Storage upload + ingestion_jobs row (status=queued)
                                ↓
   POST /api/admin/ingest/run/[jobId] (Node, fire-and-forget, sem await do cliente; Vercel mantém função viva)
                                ↓
   runPipeline: parsing → chunking → embedding (Voyage, batch 16) → inserting → done
                                ↓
   GET /api/admin/ingest/jobs (polling 2s) → IngestRoot atualiza JobsLive/JobsRecent
                                ↓
   Dedup hit (sha256 == metadata->>'content_hash' existente): stage='deduplicated', chunks_count=0
   Erro: status='error', error_message preservada, storage file mantido (B2 retry)
```
