# Sub-projeto 6c — Admin UI + Browser Ingestion

> **Status:** Design (sub-projeto 6c of 7).
> **Date:** 2026-05-02
> **Depends on:** 6a (auth + RLS, `is_admin()`, profiles), 6b (sessions table — used to count conversations per user).
> **Consumed by:** 7 (Langfuse + eval CI gate — not blocked, but admin would benefit from links into eval dashboards eventually).

## 1. Contexto

Sub-projetos 6a/6b ligaram identidade e persistência: usuários convidados via dashboard logam, conversam, e o histórico vive em `sessions` com RLS owner-only. O que ainda mora no Supabase dashboard ou no CLI Python:

- **Convite de novos usuários** — admin abre dashboard, vai em Authentication → Users → Invite, cola email.
- **Promoção a admin** — admin abre o SQL editor e roda `update profiles set role='admin' where ...`.
- **Listagem/inspeção/deleção de artigos** — não existe; só dá pra ver via SQL editor.
- **Ingestão de novos artigos** — `python scripts/ingest.py --file <arquivo>` em uma máquina local que tenha o venv configurado.

O admin precisa abrir 3 ferramentas diferentes para operar o produto. Este sub-projeto consolida tudo em `/admin` com 3 surfaces (`/admin/users`, `/admin/articles`, `/admin/ingest`) e elimina o Python no caminho de ingestão portando a pipeline para TypeScript em runtime Node do Next.js.

Critério de pronto: rgoalves@gmail.com (único admin atual) consegue (a) convidar novo usuário pela UI e o convidado recebe email, aceita, loga; (b) promover/rebaixar; (c) listar artigos, inspecionar chunks, deletar artigos com cascata; (d) arrastar PDFs no `/admin/ingest`, ver progresso ao vivo, fechar a aba e voltar pra ver o resultado; (e) usuário não-admin vê 404 em `/admin/*`.

## 2. Objetivo

Entregar:
- Páginas: `/admin/users`, `/admin/articles`, `/admin/ingest` (sidebar + sub-rotas).
- API routes (Node runtime): `/api/admin/users`, `/api/admin/articles/[id]`, `/api/admin/ingest/{upload,run/[jobId],jobs,retry/[jobId]}`.
- Componentes: `AdminSidebar`, `UsersTable`, `InviteUserDialog`, `ArticlesSplitView`, `ArticleDetail`, `ConfirmDelete`, `IngestRoot`, `Dropzone`, `JobCard`, `JobsLive`, `JobsRecent`.
- TypeScript port da pipeline em `lib/ingest/`: `parser.ts` (pdf-parse | mammoth | fs.readFile), `chunker.ts`, `metadata.ts`, `hash.ts`, `pipeline.ts`, `types.ts`.
- Auth helper: `requireAdmin()` em `lib/auth.ts`; classe `NotAdmin`.
- Migration `00000000000005_admin_ui.sql`: tabela `ingestion_jobs`, política `profiles_admin_update`, política `articles_admin_delete`, view `profiles_with_email`, helper `admin_user_session_counts()`, políticas Storage para bucket `ingest-uploads`.
- Bucket Supabase Storage `ingest-uploads` (criado manualmente via dashboard, documentado).
- Link "Admin" no `UserRow` da sidebar do `/chat`, visível só para admins.
- Total de 37 testes vitest novos. Pytest 23/23 inalterado.

**Não-objetivos** (delegados ou cortados):
- Bulk operations (selecionar N artigos para deletar) — adicionar quando houver demanda.
- Re-indexar artigo (re-embedar) — adiar; deletar+ingerir já cobre.
- Audit log de ações admin — adiar para milestone futuro.
- Vercel Realtime no lugar de polling — funcionalmente equivalente; polling é mais simples.
- Edge runtime nas rotas admin — Node necessário (service-role + Buffer + pdf-parse + mammoth).
- Manter pipeline Python — fica no repo como legacy (não deletada), não usada em produção.
- "Copy invite link" fallback — adicionar se SMTP falhar; não bloqueante.
- Configuração de tema/idioma por usuário em `/admin` — sub-projeto separado.
- Métricas agregadas (gráficos) — sub-projeto 7 cuida disso via Langfuse.

## 3. Stack

- `pdf-parse` (~30k weekly) — parser PDF puro JS, sem deps nativas. Multi-coluna não é suportado; mitigação: guard `<500 caracteres → erro "OCR necessário"`.
- `mammoth` — DOCX → text/HTML.
- `fs/promises` — TXT.
- `@supabase/supabase-js` (já presente) — Storage + admin API + DB.
- shadcn/ui base-nova (já presente) — `button`, `dialog`, `input`, `dropdown-menu`, `table` (adicionar via CLI se ainda não instalados).
- `react-dropzone` (~3.5M weekly, leve) — drag/drop polish; alternativa: implementar nativamente com eventos `dragover`/`drop` (~30 linhas) para evitar a dep — **decisão: nativo, sem dep nova**.
- Vercel AI SDK / Voyage / Cohere / Gemini wrappers — reusados via `lib/llm/*` existente.

Nenhuma dependência runtime nova além de `pdf-parse` e `mammoth`.

## 4. Estrutura de pastas

```
/app
  /admin
    layout.tsx                        # NEW — server; requireAdmin(); renders <AdminSidebar/> + {children}
    page.tsx                          # NEW — redirect to /admin/users
    /users/page.tsx                   # NEW — server; lists profiles + auth.users.last_sign_in_at + sessions count
    /articles/page.tsx                # NEW — client wrapper around <ArticlesSplitView/>
    /ingest/page.tsx                  # NEW — client wrapper around <IngestRoot/>
  /api
    /admin
      /users/route.ts                 # NEW — GET list, POST invite, PATCH role
      /articles/[id]/route.ts         # NEW — DELETE
      /ingest
        /upload/route.ts              # NEW — multipart, Storage, job row
        /run/[jobId]/route.ts         # NEW — runs pipeline.ts
        /jobs/route.ts                # NEW — GET list, runs cleanup pass
        /retry/[jobId]/route.ts       # NEW — resets error job, fires /run

/components/admin
  AdminSidebar.tsx                    # NEW
  UsersTable.tsx                      # NEW
  InviteUserDialog.tsx                # NEW
  ArticlesSplitView.tsx               # NEW
  ArticleDetail.tsx                   # NEW
  ConfirmDelete.tsx                   # NEW
  IngestRoot.tsx                      # NEW
  Dropzone.tsx                        # NEW
  JobCard.tsx                         # NEW
  JobsLive.tsx                        # NEW
  JobsRecent.tsx                      # NEW

/components/auth
  UserRow.tsx                         # MODIFY — show "Admin" link if profile.role === 'admin'

/lib
  auth.ts                             # MODIFY — add requireAdmin(), NotAdmin class
  /ingest                             # NEW
    parser.ts
    chunker.ts
    metadata.ts
    hash.ts
    pipeline.ts
    types.ts
  /db
    storage.ts                        # NEW — Storage wrappers (upload/get/delete from 'ingest-uploads')

/supabase/migrations
  00000000000005_admin_ui.sql         # NEW — ingestion_jobs, RLS, profiles_admin_update, articles_admin_delete, profiles_with_email view, admin_user_session_counts()

/tests
  /lib
    auth.test.ts                      # MODIFY — +2 tests for requireAdmin
    /ingest
      parser.test.ts                  # NEW — 4 tests
      chunker.test.ts                 # NEW — 3 tests
      metadata.test.ts                # NEW — 3 tests
      hash.test.ts                    # NEW — 1 test
      pipeline.test.ts                # NEW — 3 tests
  /components/admin
    UsersTable.test.tsx               # NEW — 3 tests
    InviteUserDialog.test.tsx         # NEW — 2 tests
    ArticlesSplitView.test.tsx        # NEW — 3 tests
    Dropzone.test.tsx                 # NEW — 3 tests
    JobCard.test.tsx                  # NEW — 2 tests
  /api/admin
    users.test.ts                     # NEW — 4 tests
    ingest-upload.test.ts             # NEW — 2 tests
    ingest-jobs.test.ts               # NEW — 2 tests

package.json                          # MODIFY — add pdf-parse, mammoth
```

## 5. Componentes — contratos

### 5.1 `lib/auth.ts` (additions)

```ts
export class NotAdmin extends Error {
  constructor() { super('NOT_ADMIN'); this.name = 'NotAdmin'; }
}

export async function requireAdmin(): Promise<{ user: User; profile: Profile }> {
  const user = await requireUser();   // throws NotAuthenticated
  const profile = await getProfile(user.id);
  if (!profile || profile.role !== 'admin') throw new NotAdmin();
  return { user, profile };
}
```

Server components/layouts catch `NotAdmin` and call `notFound()` from `next/navigation`. API routes catch and return `404` (don't reveal that `/admin/*` exists to non-admins).

### 5.2 `app/admin/layout.tsx`

```tsx
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try { await requireAdmin(); } catch { notFound(); }
  return (
    <div className="flex min-h-screen">
      <AdminSidebar />
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
```

### 5.3 `components/admin/AdminSidebar.tsx`

Persistent left sidebar (200px). Items: `Usuários` → `/admin/users`, `Artigos` → `/admin/articles`, `Ingestão` → `/admin/ingest`. Bottom: `← Voltar ao chat` → `/chat`. Active item highlighted with `--brand` color. Dark sidebar (`bg-slate-900` text-white) to mirror `/chat` Sidebar visual rhythm.

### 5.4 `components/admin/UsersTable.tsx`

Compact table. Columns: Email · Papel (pill) · Último acesso · Conversas · ⋯ menu. Header has `<InviteUserDialog/>` trigger button (`+ Convidar usuário`). ⋯ menu items per row:
- `Promover a admin` (visible if role='user')
- `Rebaixar a usuário` (visible if role='admin' AND row.id !== currentUser.id)
- `Reenviar convite` (visible if pending — i.e. last_sign_in_at is null)

Loads via server component — `app/admin/users/page.tsx` fetches `profiles_with_email` join + `admin_user_session_counts()` server-side, passes the rows in. Client mutations re-fetch via `router.refresh()`.

### 5.5 `components/admin/InviteUserDialog.tsx`

Single email input + "Enviar convite" button. On submit:
```ts
const res = await fetch('/api/admin/users', { method: 'POST', body: JSON.stringify({ email }) });
```
Errors render inline:
- 409 → "Este email já está cadastrado."
- 500 → "Não foi possível enviar o convite — tente novamente."
On 200: dialog closes, toast "Convite enviado para {email}", `router.refresh()`.

### 5.6 `components/admin/ArticlesSplitView.tsx`

Two-pane. Left (60%): table with Título (with filename meta) + Chunks count. Search input above. Right (40%): selected article's `<ArticleDetail/>` (or empty state "Selecione um artigo").

Article list loads via client `useEffect` calling `supabaseBrowser().from('articles').select('id, title, author, language, content_hash, created_at, chunks(count)').order('created_at', { ascending: false }).limit(100)`. Search is client-side filter on the loaded set (≤100 rows). For >100, add server pagination later.

### 5.7 `components/admin/ArticleDetail.tsx`

Right-panel content. Shows metadata (title, author, lang, date, chunks_count, hash truncated), action row with `Excluir` (red), then chunk list (first 20 chunks, ordered by chunk_index). Each chunk in a small framed block showing index + text excerpt (first 200 chars).

`Excluir` → `<ConfirmDelete/>` modal → DELETE `/api/admin/articles/[id]` → on success, parent clears selection and refetches list.

### 5.8 `components/admin/IngestRoot.tsx`

Composes `<Dropzone/>`, `<JobsLive/>`, `<JobsRecent/>`. Owns no state itself; jobs come from `JobsLive`'s polling. Layout per Q9-A:
- Header: "Ingestão" + stat line
- Dropzone (large)
- "Em andamento" section → `<JobsLive/>`
- "Recentes" section → `<JobsRecent/>`

### 5.9 `components/admin/Dropzone.tsx`

Native drag/drop (no react-dropzone dep). Renders the visual per mockup Q9-A. Accepts file picker click. Client-side validation:
- `file.size <= 10 * 1024 * 1024` else toast "Arquivo > 10 MB"
- `file.type` ∈ `['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain']` else toast "Tipo não suportado"

For each valid file:
```ts
const fd = new FormData(); fd.append('file', file);
const res = await fetch('/api/admin/ingest/upload', { method: 'POST', body: fd });
const { jobId } = await res.json();
fetch(`/api/admin/ingest/run/${jobId}`); // fire-and-forget; do NOT await
```

After all uploads kick off, force a poll refresh in `<JobsLive/>` via shared context or callback.

### 5.10 `components/admin/JobsLive.tsx`

Polls `/api/admin/ingest/jobs` every 2s while at least one job is `running` or `queued`. Renders queued + running jobs as `<JobCard/>` instances with progress bar + stage label. Stops polling 5s after the last job finishes.

### 5.11 `components/admin/JobsRecent.tsx`

Same data source (single fetch shared via context with JobsLive — ideally one polling loop in IngestRoot). Renders `done` and `error` jobs, capped at 10 most recent. Error jobs show Retry button → POST `/api/admin/ingest/retry/[jobId]`.

### 5.12 `components/admin/JobCard.tsx`

Per mockup Q9-A. Status icon (queued ·, running ↻, done ✓, error !), filename, stage text ("Embedding chunk 18/42" etc.), progress track (only for running), pct, time-ago.

### 5.13 `components/auth/UserRow.tsx` (modify)

Add a small "Admin" link (icon + label) above "Sair", visible only when `profile.role === 'admin'`. Routes to `/admin`. Pass `profile` from server component down through Sidebar → UserRow.

### 5.14 `lib/ingest/parser.ts`

```ts
export type ParsedFile = { text: string; pageCount?: number };

export async function parseFile(buf: Buffer, mime: string, filename: string): Promise<ParsedFile> {
  let text: string;
  let pageCount: number | undefined;

  if (mime === 'application/pdf') {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buf);
    text = data.text;
    pageCount = data.numpages;
  } else if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer: buf });
    text = value;
  } else if (mime === 'text/plain') {
    text = buf.toString('utf-8');
  } else {
    throw new Error(`Tipo não suportado: ${mime}`);
  }

  if (text.trim().length < 500) {
    throw new Error('PDF parece escaneado — OCR necessário (texto extraído < 500 caracteres)');
  }

  return { text: text.replace(/ /g, ''), pageCount };
}
```

### 5.15 `lib/ingest/chunker.ts`

Port the Python semantic chunker rules: split on double-newline (paragraph), then any paragraph >2000 chars splits on sentence boundary, then any chunk >2400 chars hard-cuts at 2400 with 200-char overlap. Returns `string[]`.

### 5.16 `lib/ingest/metadata.ts`

Heuristics (mirror Python):
- `title`: first line of text if length 10-200 and looks like a title (no period at end, mostly word chars). Fallback: filename without extension.
- `author`: regex `/^(?:Autor|Author|By)[:\s]+(.+)$/im`. Fallback: null.
- `language`: count PT-specific stopwords (`o, a, de, que, e, do, da, em, para, com`) vs EN (`the, of, and, to, in, that, for, with`); winner is detected lang. Default 'pt'.
- `date`: regex match `/(20\d{2})/` in first 500 chars; ISO format. Fallback: null.

### 5.17 `lib/ingest/hash.ts`

```ts
import { createHash } from 'node:crypto';
export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
```

### 5.18 `lib/ingest/pipeline.ts`

```ts
export async function runPipeline(jobId: string): Promise<void> {
  const sb = supabaseService();   // service-role for cross-user writes
  const update = (patch: Partial<IngestJob>) =>
    sb.from('ingestion_jobs').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', jobId);

  try {
    const { data: job } = await sb.from('ingestion_jobs').select('*').eq('id', jobId).single();
    if (!job) throw new Error('job not found');

    await update({ status: 'running', stage: 'parsing', progress: 5 });
    const blob = await downloadFromStorage(job.storage_path);
    const parsed = await parseFile(blob, job.mime_type, job.filename);

    await update({ stage: 'chunking', progress: 20 });
    const chunks = chunkText(parsed.text);
    if (chunks.length === 0) throw new Error('Nenhum chunk gerado a partir do texto');

    const meta = extractMetadata(parsed.text, job.filename);
    const hash = sha256(blob);

    const { data: existing } = await sb.from('articles').select('id').eq('content_hash', hash).maybeSingle();
    if (existing) {
      await deleteFromStorage(job.storage_path);
      await update({ status: 'done', stage: 'deduplicated', progress: 100, chunks_count: 0,
                     article_id: existing.id, finished_at: new Date().toISOString() });
      return;
    }

    const { data: article } = await sb.from('articles').insert({
      title: meta.title, author: meta.author, language: meta.language,
      published_date: meta.date, content_hash: hash, source_filename: job.filename,
    }).select('id').single();

    await update({ stage: 'embedding', progress: 40 });
    const embeddings: number[][] = [];
    const batchSize = 16;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const slice = chunks.slice(i, i + batchSize);
      const out = await voyageEmbed(slice, 'document');
      embeddings.push(...out);
      const pct = 40 + Math.floor(((i + slice.length) / chunks.length) * 50);
      await update({ progress: Math.min(pct, 90) });
    }

    await update({ stage: 'inserting', progress: 92 });
    const rows = chunks.map((text, idx) => ({
      article_id: article!.id, chunk_index: idx, content: text, embedding: embeddings[idx],
    }));
    for (let i = 0; i < rows.length; i += 50) {
      await sb.from('chunks').insert(rows.slice(i, i + 50));
    }

    await deleteFromStorage(job.storage_path);
    await update({ status: 'done', stage: null, progress: 100, chunks_count: chunks.length,
                   article_id: article!.id, finished_at: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro desconhecido';
    await update({ status: 'error', error_message: message, finished_at: new Date().toISOString() });
    // do NOT delete storage on error (B2 retention)
  }
}
```

### 5.19 `lib/ingest/types.ts`

```ts
export type JobStatus = 'queued' | 'running' | 'done' | 'error';
export type JobStage = 'parsing' | 'chunking' | 'embedding' | 'inserting' | 'deduplicated' | null;
export type IngestJob = {
  id: string; user_id: string; filename: string; storage_path: string;
  size_bytes: number; mime_type: string; status: JobStatus; stage: JobStage;
  progress: number; chunks_count: number | null; article_id: string | null;
  error_message: string | null; created_at: string; updated_at: string; finished_at: string | null;
};
```

### 5.20 `lib/db/storage.ts`

```ts
const BUCKET = 'ingest-uploads';

export async function uploadToStorage(userId: string, jobId: string, filename: string, buf: Buffer, contentType: string): Promise<string> {
  const path = `${userId}/${jobId}/${filename}`;
  const { error } = await supabaseService().storage.from(BUCKET).upload(path, buf, { contentType, upsert: false });
  if (error) throw error;
  return path;
}

export async function downloadFromStorage(path: string): Promise<Buffer> {
  const { data, error } = await supabaseService().storage.from(BUCKET).download(path);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

export async function deleteFromStorage(path: string): Promise<void> {
  await supabaseService().storage.from(BUCKET).remove([path]);
}
```

### 5.21 API routes

All Node runtime (`export const runtime = 'nodejs'`).

**`POST /api/admin/users`** — body `{ email }`. `requireAdmin()`. Service-role: `auth.admin.inviteUserByEmail(email, { redirectTo: '<origin>/auth/callback?next=/reset-password' })`. Returns `{ ok: true }` or `{ error: 'user_already_exists' }` (409) or `{ error: 'invite_failed' }` (500).

**`PATCH /api/admin/users`** — body `{ user_id, role }`. `requireAdmin()`. Self-demote guard: if `user_id === auth.uid() && role === 'user'` → 400. Update `profiles.role` via authed session (uses `profiles_admin_update` policy).

**`GET /api/admin/users`** — `requireAdmin()`. Selects `profiles_with_email` + joins `admin_user_session_counts()`. Returns array.

**`DELETE /api/admin/articles/[id]`** — `requireAdmin()`. Deletes article (cascades chunks via FK). Returns `{ ok: true }`.

**`POST /api/admin/ingest/upload`** — multipart. `requireAdmin()`. Reads single file from FormData. Server-side re-validates size + mime. Inserts `ingestion_jobs` row (`status='queued'`). Uploads buffer to Storage at `<user_id>/<job_id>/<filename>`. Returns `{ jobId }`.

**`POST /api/admin/ingest/run/[jobId]`** — `requireAdmin()`. Verifies the job exists (any admin can run any admin's job — RLS via service-role from inside `runPipeline`). Awaits `runPipeline(jobId)` so the function keeps running on Vercel. The browser fires this without `await`; Vercel holds the function alive for the pipeline duration even after the originating request returns. Returns `{ ok: true }` when pipeline finishes.

**`GET /api/admin/ingest/jobs`** — `requireAdmin()`. First runs cleanup pass:
```sql
delete from ingestion_jobs where status = 'done' and finished_at < now() - interval '7 days';
update ingestion_jobs set status = 'error', error_message = 'Job interrompido'
  where status = 'running' and updated_at < now() - interval '5 minutes';
```
Then selects all jobs (no status filter), ordered by `(case status when 'running' then 0 when 'queued' then 1 when 'error' then 2 else 3 end), created_at desc`. Returns array. Storage cleanup for the deleted rows: list paths from a SELECT of to-be-deleted rows before the DELETE, then `storage.remove(paths)` (best-effort, no fail-on-missing).

**`POST /api/admin/ingest/retry/[jobId]`** — `requireAdmin()`. Verifies job is in `error` state. Updates row via service-role: `status='queued', stage=null, progress=0, error_message=null, finished_at=null`. Awaits `runPipeline(jobId)` (the route runs to completion; the browser fires this without `await`, same fire-and-forget pattern as the initial `/run`). Returns `{ ok: true }`.

## 6. Database — migration

`supabase/migrations/00000000000005_admin_ui.sql`:

```sql
-- 6c.1 — ingestion_jobs
create table ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  filename text not null,
  storage_path text not null,
  size_bytes bigint not null,
  mime_type text not null,
  status text not null default 'queued' check (status in ('queued','running','done','error')),
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

create policy ingestion_jobs_admin_select on ingestion_jobs for select to authenticated using (is_admin());
create policy ingestion_jobs_admin_insert on ingestion_jobs for insert to authenticated
  with check (is_admin() and user_id = auth.uid());
create policy ingestion_jobs_admin_update on ingestion_jobs for update to authenticated
  using (is_admin()) with check (is_admin());
create policy ingestion_jobs_admin_delete on ingestion_jobs for delete to authenticated using (is_admin());

-- 6c.2 — profiles: admin can update role
create policy profiles_admin_update on profiles for update to authenticated
  using (is_admin()) with check (is_admin());

-- 6c.3 — articles: admin can delete (chunks cascade via existing FK)
create policy articles_admin_delete on articles for delete to authenticated using (is_admin());

-- 6c.4 — admin view of profiles + auth.users.email
create or replace view profiles_with_email
with (security_invoker = true) as
  select p.id, p.role, p.display_name, p.created_at,
         u.email, u.last_sign_in_at, u.created_at as auth_created_at
    from profiles p
    join auth.users u on u.id = p.id;

grant select on profiles_with_email to authenticated;

-- 6c.5 — sessions count helper
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
```

**Storage policies** (apply via dashboard SQL editor after creating bucket):
```sql
create policy ingest_uploads_admin_all on storage.objects for all to authenticated
  using (bucket_id = 'ingest-uploads' and is_admin())
  with check (bucket_id = 'ingest-uploads' and is_admin()
              and (storage.foldername(name))[1] = auth.uid()::text);
```

## 7. Supabase setup (manual, one-time)

Documented in plan as explicit task steps:

1. **Storage → Buckets → New bucket:** name `ingest-uploads`, public OFF, file size limit 10 MB, allowed MIME types `application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document, text/plain`.
2. **Storage → Policies → SQL editor:** apply the policy above.
3. **Authentication → Email Templates → Invite user:** verify default template is acceptable PT-BR (or update). The invite URL uses the redirect from the API call, so no template URL change needed.
4. **Verify SMTP works:** the existing reset-password flow already proves this; no extra setup.

## 8. Testing

### 8.1 Unit (vitest, 37 new)

| File | # | Covers |
|---|---|---|
| `tests/lib/auth.test.ts` (additions) | 2 | requireAdmin allows admin, throws NotAdmin for user |
| `tests/lib/ingest/parser.test.ts` | 4 | parsePdf, parseDocx, parseTxt, <500-char guard throws |
| `tests/lib/ingest/chunker.test.ts` | 3 | paragraph split, max-char wrap, empty input → empty array |
| `tests/lib/ingest/metadata.test.ts` | 3 | title from first heading, author from `^Author:` line, lang detect PT vs EN |
| `tests/lib/ingest/hash.test.ts` | 1 | sha256 stable for known input |
| `tests/lib/ingest/pipeline.test.ts` | 3 | happy path, parser failure → status=error, dedup hit → chunks_count=0 |
| `tests/components/admin/UsersTable.test.tsx` | 3 | renders rows, role menu opens, invite button opens dialog |
| `tests/components/admin/InviteUserDialog.test.tsx` | 2 | submit calls API, error renders inline |
| `tests/components/admin/ArticlesSplitView.test.tsx` | 3 | renders list, click loads detail, delete confirms then fires DELETE |
| `tests/components/admin/Dropzone.test.tsx` | 3 | drop fires upload, oversize rejected, wrong MIME rejected |
| `tests/components/admin/JobCard.test.tsx` | 2 | running renders progress bar + stage, error renders Retry |
| `tests/api/admin/users.test.ts` | 4 | non-admin → 404, invite happy, role patch happy, self-demote → 400 |
| `tests/api/admin/ingest-upload.test.ts` | 2 | persists to storage + creates job row, non-admin → 404 |
| `tests/api/admin/ingest-jobs.test.ts` | 2 | returns admin's view, runs cleanup pass on call |

**Mocks:** Supabase clients (browser + server + service), Voyage/Cohere/Gemini, `pdf-parse`, `mammoth`, Storage. Pipeline tests use Buffer fixtures. No live network.

Suite total: 89 + 37 = **126 vitest**. Pytest 23/23 unchanged.

### 8.2 Smoke (manual, after migration applied)

1. Login as admin → click "Admin" in sidebar UserRow → land on `/admin/users`.
2. Login as a non-admin (create a second account) → `/admin` returns 404.
3. Invite a fresh email → check inbox → accept → land on `/chat`; back in `/admin/users` row appears with no pending pill.
4. Promote new user → log in as that user → `/admin/users` accessible.
5. Demote self → 400 toast.
6. Drop a 5-page PDF on `/admin/ingest` → live card progresses parsing → embedding → done; `/admin/articles` shows the new title.
7. Drop the same PDF again → done with stage='deduplicated', no duplicate.
8. Drop a corrupted PDF → error card with Retry → click Retry → still errors.
9. `/admin/articles` → click row → right panel → Excluir → confirm → row gone, chunks count → 0.
10. Test cleanup: manually `update ingestion_jobs set finished_at = now() - interval '8 days' where status = 'done'` then hit `/admin/ingest` → row vanishes from list.
11. Regressions: `npm test` 126/126, typecheck zero, pytest 23/23, `/api/health` 200, `/chat` works for both admin and regular user.

## 9. Critérios de sucesso

1. Admin can invite a new user via UI; invite email arrives; user accepts and logs in.
2. Admin can promote a user to admin; demoted role takes effect on next request.
3. Admin cannot demote self (400 with clear message).
4. `/admin/articles` lists articles; row click shows chunks; delete removes article and cascades chunks (verified by chunks count → 0).
5. Admin drops PDF → ingestion job appears in real time → completes in <2 min for an 80-page PDF → article + chunks visible in `/admin/articles`.
6. Same PDF dropped twice → second is detected by SHA-256, no duplicate article.
7. Corrupted/scanned PDF → clear error message; Retry available.
8. Closing the browser tab mid-ingest does not kill the job (verify by reopening 30s later, status updated to done).
9. Done jobs disappear from list after 7 days; error jobs persist.
10. Non-admin user cannot reach `/admin/*` (404) or `/api/admin/*` (404).
11. `npm test` ≥ 126; typecheck zero errors; pytest 23/23 unchanged; `/api/health` 200.
12. Tag `admin-ui-complete` on the final commit.

## 10. Decisões e justificativas

| Decisão | Por quê |
|---|---|
| Sidebar + sub-routes (Q6-B) | Bookmarkable, scales to more sections later, mirrors `/chat` sidebar visually |
| Compact users table (Q7-A) | Internal tool — scanning > warmth |
| Split-view articles (Q8-B) | Inspecting chunks is the primary drilldown; keep the list always visible |
| Stacked ingest with live cards (Q9-A) | Event-driven workflow; admin watches while running |
| `auth.admin.inviteUserByEmail` (Q5-A) | Existing SMTP works; admin API handles dedup; closest to "click button done" |
| TS port of pipeline (Q2-B) | Eliminates Python deploy story; reuses existing TS LLM wrappers |
| Fire-and-forget + polling (Q3-B) | Smallest step beyond sync that survives tab close; no extra infra |
| `pdf-parse` for PDFs (Q11-A) | Simplest path; <500-char guard catches OCR-required cases |
| 7d done cleanup, errors forever, file kept on error (Q10 A2+B2) | Retry needs the file; success doesn't; debugging needs error history |
| Service-role for invite + admin delete | Required by Supabase admin API; routes are admin-gated |
| User-scoped Storage paths | Policy enforces admins can only write under their own auth.uid() folder |
| Native drag/drop, no react-dropzone dep | ~30 lines; avoids new dep |
| Pipeline polling cleanup inline | No cron needed; opportunistic; cheap |
| Stale-job sweep (>5 min running) | Catches pipeline crashes without restart hooks |
| Admin link visible only to admins | UI also gates; defense in depth |
| 404 (not 403) for non-admins | Don't reveal `/admin/*` exists |

## 11. Riscos

| Risk | Mitigation |
|---|---|
| Vercel function timeout cuts off 100+ page PDFs | Client rejects >10 MB at upload; documented bound; legacy Python CLI still available for outliers |
| Fire-and-forget relies on Vercel keeping fn alive after originating request returns | Documented Vercel behavior; fall back to Vercel cron polling `queued` if it changes |
| pdf-parse loses multi-column layout vs unstructured.io | <500-char guard catches the worst; sub-projeto 7 golden eval will surface real regressions |
| Self-referential RLS recursion via `is_admin()` | Already solved via security-definer pattern from 6a |
| Auto-cleanup race with just-completed job | Cleanup deletes only `done` with `finished_at < now() - 7d`; just-completed has `finished_at = now()` → safe |
| Storage policy lets admin write to anyone's user_id folder | Policy enforces `(storage.foldername(name))[1] = auth.uid()::text` for inserts |
| Long pipeline crashes mid-flight, leaves job 'running' | Stale-job sweep in `/jobs` endpoint marks `running` + `updated_at < now() - 5min` as 'error' |
| Invite email goes to spam | Existing reset-password uses same SMTP; if reset works, invite works. "Copy invite link" fallback can be added without rework |
| Admin deletes article currently being retrieved by another user | No FK violation possible; current chat UI doesn't show citations, so user sees no broken refs |
| `pdf-parse` has a known issue with "test/data/05-versions-space.pdf" lookup at import time | Use dynamic `import('pdf-parse')` inside the function (covered in §5.14); never import at module top level |

## 12. Sequência de implementação (esboço)

A ordem detalhada vai para o plano. Esqueleto:

1. Add deps `pdf-parse`, `mammoth`.
2. Migration `00000000000005_admin_ui.sql` + apply via psycopg.
3. Storage bucket + policy via dashboard.
4. `lib/auth.ts` add `requireAdmin` + 2 tests (TDD).
5. `lib/ingest/hash.ts` + 1 test.
6. `lib/ingest/parser.ts` + 4 tests.
7. `lib/ingest/chunker.ts` + 3 tests.
8. `lib/ingest/metadata.ts` + 3 tests.
9. `lib/ingest/types.ts` + `lib/db/storage.ts`.
10. `lib/ingest/pipeline.ts` + 3 tests.
11. `app/api/admin/users/route.ts` + 4 tests.
12. `app/api/admin/articles/[id]/route.ts`.
13. `app/api/admin/ingest/upload/route.ts` + 2 tests.
14. `app/api/admin/ingest/run/[jobId]/route.ts`.
15. `app/api/admin/ingest/jobs/route.ts` + 2 tests.
16. `app/api/admin/ingest/retry/[jobId]/route.ts`.
17. `components/admin/AdminSidebar.tsx`.
18. `app/admin/layout.tsx` + `app/admin/page.tsx`.
19. `components/admin/UsersTable.tsx` + 3 tests.
20. `components/admin/InviteUserDialog.tsx` + 2 tests.
21. `app/admin/users/page.tsx`.
22. `components/admin/ArticleDetail.tsx` + `ConfirmDelete.tsx`.
23. `components/admin/ArticlesSplitView.tsx` + 3 tests.
24. `app/admin/articles/page.tsx`.
25. `components/admin/JobCard.tsx` + 2 tests.
26. `components/admin/Dropzone.tsx` + 3 tests.
27. `components/admin/JobsLive.tsx` + `JobsRecent.tsx` + `IngestRoot.tsx`.
28. `app/admin/ingest/page.tsx`.
29. `components/auth/UserRow.tsx` modify — show Admin link.
30. CLAUDE.md update — sub-projeto 6c row + new file paths + new gotchas.
31. Smoke + tag `admin-ui-complete`.
