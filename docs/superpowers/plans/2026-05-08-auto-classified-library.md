# Auto-classified Library Implementation Plan (Sub-projeto 13)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace heuristic title extraction with an LLM that produces `{ title, theme, summary }` per article during ingestion. Add a fixed taxonomy of 11 procurement themes, a sidebar in `/admin/articles` to navigate by theme, inline admin override of title/theme, and a backfill script that re-classifies existing articles via `articles.raw_md` (no re-upload).

**Architecture:** A new `classifyContent()` (`lib/ingest/classify-content.ts`) calls OpenAI `gpt-4o-mini` with `response_format: json_object`, validates with zod, and fails soft to a filename-derived fallback. The pipeline orders dedup-check BEFORE the classifier so duplicate uploads cost zero OpenAI tokens. `articles` gets two new columns (`theme` not null with CHECK constraint, `summary` nullable) via migration `0010`. Admin UI gains a 3-column layout with a `<ThemeSidebar>` on the left, the existing list/detail in the center/right, plus inline title editing and a theme dropdown that PATCH the article row.

**Tech Stack:** Next.js 14 App Router (Node runtime on admin routes), Supabase Postgres + RLS, OpenAI SDK (`openai` v5) with `gpt-4o-mini`, zod, vitest, TypeScript strict, shadcn base-nova UI.

**Spec:** `docs/superpowers/specs/2026-05-08-auto-classified-library-design.md`

---

## File Structure

**New files:**
- `supabase/migrations/00000000000010_articles_theme.sql` — adds `theme` (not null, default `'Outros'`, CHECK constraint, GIN index) + `summary` (nullable)
- `lib/ingest/taxonomy.ts` — `TAXONOMY` const, `Theme` type, `isValidTheme`, `THEME_DESCRIPTIONS`
- `lib/ingest/classify-content.ts` — `classifyContent(text, filename)` LLM call + zod + fail-soft
- `scripts/reclassify.ts` — CLI that backfills `title`/`theme`/`summary` from `articles.raw_md`
- `components/admin/ThemeSidebar.tsx` — vertical theme list with counts, click-to-filter
- `components/admin/EditableTitle.tsx` — inline editable `<h3>` with pencil button + save/cancel
- `tests/lib/ingest/taxonomy.test.ts`
- `tests/lib/ingest/classify-content.test.ts`
- `tests/api/admin/articles-patch.test.ts`
- `tests/components/admin/ThemeSidebar.test.tsx`

**Modified files:**
- `lib/ingest/pipeline.ts` — reorders to dedup-first, then `classifyContent`, then insert with `theme`/`summary`
- `app/api/admin/articles/[id]/route.ts` — adds `PATCH` handler with zod body validation
- `components/admin/ArticleDetail.tsx` — adds `summary` render, theme dropdown, editable title, `onUpdated` callback
- `components/admin/ArticlesSplitView.tsx` — extends to 3-column layout, accepts theme filter, propagates `onUpdated`
- `tests/lib/ingest/pipeline.test.ts` — extends with classify mock + dedup-before-classify test
- `tests/components/admin/ArticleDetail.test.tsx` (if exists, else new) — covers edit interactions
- `package.json` — adds `articles:reclassify` script
- `scripts/eval/golden.json` — realigns `expected_titles` to match LLM-produced canonical titles (Task 11, after backfill)
- `docs/product/beta-smoke-test.md` — appends sub-projeto 13 smoke checklist
- `CLAUDE.md` — sub-projeto 13 row + structure update + gotchas

---

## Conventions

- **Test runner:** `npm test` (vitest run, all suites). Single file: `npm test -- tests/lib/ingest/classify-content.test.ts`. Use `vi.doMock` + `vi.resetModules()` for module-level mocks (canonical pattern from `tests/lib/ingest/pipeline.test.ts`).
- **OpenAI SDK mock:** `vi.doMock('@/lib/llm/openai', () => ({ getOpenAI: () => ({ chat: { completions: { create: vi.fn() } } }), getOpenAIModel: () => 'gpt-4o-mini' }))` — same pattern as `tests/lib/rag/condenser.test.ts` (post sub-projeto LLM swap).
- **Component tests:** require `// @vitest-environment jsdom` directive on line 1 (config defaults to `node`). See `tests/components/chat/Message.test.tsx`.
- **Typecheck:** `npm run typecheck`. Run after every task that touches types or moved imports.
- **Branch:** `main` (project pattern — sub-projetos 8/9/10/11/12/13 went direct to main).
- **Commits:** atomic per task. Format `<type>(<scope>): <subject>` with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` footer.
- **Migration application:** Apply via Supabase dashboard SQL editor against project `ohfgrcnouudzshnpziiw` (codebase target — see `memory/supabase_projects.md`). The MCP `apply_migration` tool can't reach this project; use the dashboard.
- **Tag at end:** after Task 11 passes locally + CI green, apply `auto-classified-library-complete`.

---

## Task 1: Schema migration `0010`

Add `theme` (not null, default `'Outros'`, CHECK against the 11 fixed values) and `summary` (nullable text) to `articles`. Existing 3 rows get default `'Outros'` automatically. CHECK constraint protects against typos. GIN-on-text would be overkill — a btree index on `theme` is enough for the small filter cardinality.

**Files:**
- Create: `supabase/migrations/00000000000010_articles_theme.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Sub-projeto 13 — auto-classified library
alter table articles
  add column theme text not null default 'Outros',
  add column summary text;

alter table articles
  add constraint articles_theme_check
    check (theme in (
      'Kraljic',
      'Sourcing Estratégico',
      'SRM',
      'TCO',
      'Sustentabilidade',
      'Risco / Resiliência',
      'Negociação / Contratos',
      'Performance / KPIs',
      'Digital / Tecnologia',
      'Setor Público',
      'Outros'
    ));

create index articles_theme_idx on articles (theme);
```

- [ ] **Step 2: Apply via Supabase dashboard**

Open https://supabase.com/dashboard/project/ohfgrcnouudzshnpziiw/sql/new, paste the migration, run. Confirm success message.

- [ ] **Step 3: Verify columns + constraint via psycopg**

Run:
```bash
scripts/.venv/Scripts/python.exe -c "
import os, psycopg
from pathlib import Path
env_path = Path('.env.local')
for line in env_path.read_text(encoding='utf-8').splitlines():
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line: continue
    k, v = line.split('=', 1)
    os.environ.setdefault(k.strip(), v.strip().strip(chr(34)).strip(chr(39)))
url = os.environ['NEXT_PUBLIC_SUPABASE_URL']
host = url.replace('https://','').replace('.supabase.co','') + '.supabase.co'
conn = psycopg.connect(f'postgresql://postgres:{os.environ[\"SUPABASE_DB_PASSWORD\"]}@db.{host}:5432/postgres', autocommit=True)
with conn.cursor() as cur:
    cur.execute(\"select column_name, data_type, is_nullable from information_schema.columns where table_name='articles' and column_name in ('theme','summary')\")
    for row in cur.fetchall(): print(row)
    cur.execute(\"select count(*) from articles where theme = 'Outros'\")
    print('rows defaulted to Outros:', cur.fetchone())
conn.close()
"
```

Expected: 2 rows printed (theme + summary columns), and the default fired for the 3 existing rows.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00000000000010_articles_theme.sql
git commit -m "$(cat <<'EOF'
feat(db): migration 0010 adds articles.theme + articles.summary

Sub-projeto 13 schema. CHECK constraint on theme guards against typos
in the fixed taxonomy. Existing rows default to 'Outros'; the backfill
script (Task 9) reclassifies them via raw_md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Taxonomy module (TDD)

Pure constants + helpers. No side effects, no I/O. Used by classifier, PATCH validator, sidebar UI.

**Files:**
- Create: `lib/ingest/taxonomy.ts`
- Create: `tests/lib/ingest/taxonomy.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/ingest/taxonomy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TAXONOMY, THEME_DESCRIPTIONS, isValidTheme, type Theme } from '@/lib/ingest/taxonomy';

describe('TAXONOMY', () => {
  it('has exactly 11 themes', () => {
    expect(TAXONOMY).toHaveLength(11);
  });

  it('includes the canonical procurement themes', () => {
    expect(TAXONOMY).toContain('Kraljic');
    expect(TAXONOMY).toContain('Sourcing Estratégico');
    expect(TAXONOMY).toContain('SRM');
    expect(TAXONOMY).toContain('Outros');
  });

  it('THEME_DESCRIPTIONS covers every theme', () => {
    for (const t of TAXONOMY) {
      const desc = THEME_DESCRIPTIONS[t as Theme];
      expect(desc).toBeTruthy();
      expect(desc.length).toBeGreaterThan(10);
    }
  });
});

describe('isValidTheme', () => {
  it('returns true for every TAXONOMY entry', () => {
    for (const t of TAXONOMY) {
      expect(isValidTheme(t)).toBe(true);
    }
  });

  it('returns false for unknown strings', () => {
    expect(isValidTheme('foo')).toBe(false);
    expect(isValidTheme('')).toBe(false);
    expect(isValidTheme('kraljic')).toBe(false); // case-sensitive
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/lib/ingest/taxonomy.test.ts`
Expected: FAIL with "Cannot find module '@/lib/ingest/taxonomy'"

- [ ] **Step 3: Implement `lib/ingest/taxonomy.ts`**

```ts
export const TAXONOMY = [
  'Kraljic',
  'Sourcing Estratégico',
  'SRM',
  'TCO',
  'Sustentabilidade',
  'Risco / Resiliência',
  'Negociação / Contratos',
  'Performance / KPIs',
  'Digital / Tecnologia',
  'Setor Público',
  'Outros',
] as const;

export type Theme = (typeof TAXONOMY)[number];

export function isValidTheme(s: string): s is Theme {
  return (TAXONOMY as readonly string[]).includes(s);
}

export const THEME_DESCRIPTIONS: Record<Theme, string> = {
  'Kraljic': 'Matriz de Kraljic, categorização de itens, portfolio de compras',
  'Sourcing Estratégico': 'Strategic sourcing, seleção de fornecedores, RFx',
  'SRM': 'Supplier Relationship Management, gestão de fornecedores',
  'TCO': 'Total Cost of Ownership, custo total, análise de custo-benefício',
  'Sustentabilidade': 'Compras sustentáveis, ESG, ISO 20400/26000, circularidade',
  'Risco / Resiliência': 'Risco da cadeia, resiliência, contingência, disruptions',
  'Negociação / Contratos': 'Técnicas de negociação, gestão contratual, SLA',
  'Performance / KPIs': 'Indicadores de compras, savings, métricas de procurement',
  'Digital / Tecnologia': 'P2P, e-procurement, IA, automação, plataformas digitais',
  'Setor Público': 'Compras públicas, licitação, lei 14.133, transparência',
  'Outros': 'Não se encaixa nas demais categorias OU artigo de procurement geral',
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/lib/ingest/taxonomy.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/ingest/taxonomy.ts tests/lib/ingest/taxonomy.test.ts
git commit -m "$(cat <<'EOF'
feat(ingest): taxonomy module with 11 fixed procurement themes

TAXONOMY constant + Theme type + isValidTheme guard + THEME_DESCRIPTIONS
for the prompt context. Pure, no I/O; consumed by classifier (Task 3),
PATCH validator (Task 5), and sidebar UI (Task 6).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: classifyContent (TDD)

LLM-driven classifier. Calls OpenAI with structured-JSON mode, validates with zod, fails soft. Hard 15s timeout via AbortController. Strips quotes around title. Truncates input at 6000 chars.

**Files:**
- Create: `lib/ingest/classify-content.ts`
- Create: `tests/lib/ingest/classify-content.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/ingest/classify-content.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

function setupOpenAIMock(opts: { content?: string; throws?: Error; delayMs?: number } = {}) {
  const create = vi.fn().mockImplementation(async (_body, callOpts) => {
    if (opts.throws) throw opts.throws;
    if (opts.delayMs !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs);
        callOpts?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
    }
    return { choices: [{ message: { content: opts.content ?? '' } }] };
  });
  vi.doMock('@/lib/llm/openai', () => ({
    getOpenAI: () => ({ chat: { completions: { create } } }),
    getOpenAIModel: () => 'gpt-4o-mini',
  }));
  return { create };
}

describe('classifyContent', () => {
  it('returns parsed { title, theme, summary } on valid JSON', async () => {
    setupOpenAIMock({
      content: JSON.stringify({
        title: 'Categorização de itens em compras estratégicas',
        theme: 'Kraljic',
        summary: 'Aplica a matriz a um varejo de alimentos',
      }),
    });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    const out = await classifyContent('Texto longo. '.repeat(80), 'kraljic.pdf');
    expect(out.title).toBe('Categorização de itens em compras estratégicas');
    expect(out.theme).toBe('Kraljic');
    expect(out.summary).toBe('Aplica a matriz a um varejo de alimentos');
  });

  it('strips wrapping quotes from title', async () => {
    setupOpenAIMock({
      content: JSON.stringify({
        title: '"Aplicação prática da matriz de Kraljic"',
        theme: 'Kraljic',
        summary: 's',
      }),
    });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    const out = await classifyContent('Texto longo. '.repeat(80), 'k.pdf');
    expect(out.title).toBe('Aplicação prática da matriz de Kraljic');
  });

  it('falls back when theme is outside the taxonomy', async () => {
    setupOpenAIMock({
      content: JSON.stringify({ title: 'Algum título OK aqui', theme: 'BogusTheme', summary: '' }),
    });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    const out = await classifyContent('Texto longo. '.repeat(80), 'k.pdf');
    expect(out.theme).toBe('Outros');
    expect(out.title).toBe('k'); // filename stem fallback (no _- to replace)
  });

  it('falls back when title is too short', async () => {
    setupOpenAIMock({
      content: JSON.stringify({ title: 'curto', theme: 'Kraljic', summary: '' }),
    });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    const out = await classifyContent('Texto longo. '.repeat(80), 'kraljic-2024.pdf');
    expect(out.title).toBe('kraljic 2024');
    expect(out.theme).toBe('Outros');
  });

  it('falls back when JSON is invalid', async () => {
    setupOpenAIMock({ content: 'not json at all' });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    const out = await classifyContent('Texto longo. '.repeat(80), 'foo_bar.pdf');
    expect(out.title).toBe('foo bar');
    expect(out.theme).toBe('Outros');
    expect(out.summary).toBe('');
  });

  it('falls back when OpenAI throws (network error)', async () => {
    setupOpenAIMock({ throws: new Error('ECONNRESET') });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    const out = await classifyContent('Texto longo. '.repeat(80), 'foo.pdf');
    expect(out.theme).toBe('Outros');
    expect(out.title).toBe('foo');
  });

  it('uses empty string when summary is missing', async () => {
    setupOpenAIMock({
      content: JSON.stringify({ title: 'Título plausível com chars suficientes', theme: 'TCO' }),
    });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    const out = await classifyContent('Texto longo. '.repeat(80), 'k.pdf');
    expect(out.summary).toBe('');
    expect(out.theme).toBe('TCO');
  });

  it('truncates input at ~6000 chars before sending', async () => {
    const m = setupOpenAIMock({
      content: JSON.stringify({ title: 'Título plausível com chars suficientes', theme: 'Outros', summary: '' }),
    });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    const huge = 'x'.repeat(50_000);
    await classifyContent(huge, 'big.pdf');
    const callBody = m.create.mock.calls[0]![0];
    const userMsg = callBody.messages.find((m: { role: string }) => m.role === 'user').content as string;
    expect(userMsg.length).toBeLessThanOrEqual(6500); // some headroom for any prefix the impl adds
  });

  it('system prompt mentions at least 5 of the 11 themes', async () => {
    const m = setupOpenAIMock({
      content: JSON.stringify({ title: 'Título plausível com chars suficientes', theme: 'Outros', summary: '' }),
    });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    await classifyContent('texto', 'k.pdf');
    const callBody = m.create.mock.calls[0]![0];
    const sys = callBody.messages.find((m: { role: string }) => m.role === 'system').content as string;
    let found = 0;
    for (const t of ['Kraljic', 'Sourcing', 'SRM', 'TCO', 'Sustentabilidade', 'Risco', 'Negociação', 'Performance', 'Digital', 'Setor', 'Outros']) {
      if (sys.includes(t)) found++;
    }
    expect(found).toBeGreaterThanOrEqual(5);
  });

  it('aborts after the configured timeout (fail-soft to fallback)', async () => {
    vi.useFakeTimers();
    try {
      setupOpenAIMock({
        content: JSON.stringify({ title: 'Título OK aqui com chars', theme: 'Kraljic', summary: '' }),
        delayMs: 60_000,
      });
      const { classifyContent } = await import('@/lib/ingest/classify-content');
      const promise = classifyContent('texto', 'foo.pdf');
      vi.advanceTimersByTime(20_000);
      const out = await promise;
      expect(out.theme).toBe('Outros');
      expect(out.title).toBe('foo');
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/lib/ingest/classify-content.test.ts`
Expected: FAIL with "Cannot find module '@/lib/ingest/classify-content'"

- [ ] **Step 3: Implement `lib/ingest/classify-content.ts`**

```ts
import { z } from 'zod';
import { getOpenAI, getOpenAIModel } from '@/lib/llm/openai';
import { TAXONOMY, THEME_DESCRIPTIONS, isValidTheme, type Theme } from '@/lib/ingest/taxonomy';

const TIMEOUT_MS = 15_000;
const MAX_INPUT_CHARS = 6000;

const ClassifyResultSchema = z.object({
  title: z.string(),
  theme: z.string(),
  summary: z.string().optional(),
});

export type ClassifyResult = {
  title: string;
  theme: Theme;
  summary: string;
};

function filenameStem(filename: string): string {
  const withoutExt = filename.replace(/\.[^.]+$/, '');
  return withoutExt.replace(/[_\-]+/g, ' ').trim();
}

function fallback(filename: string): ClassifyResult {
  const stem = filenameStem(filename);
  return { title: stem || 'Sem título', theme: 'Outros' as Theme, summary: '' };
}

function stripWrappingQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function buildSystemPrompt(): string {
  const descriptions = TAXONOMY.map((t) => `  - ${t}: ${THEME_DESCRIPTIONS[t]}`).join('\n');
  return `Você é um especialista em procurement (compras corporativas) classificando artigos acadêmicos. Receba um trecho de texto extraído do artigo e devolva JSON com EXATAMENTE 3 campos:

- title: string em português (ou idioma original se não for PT) com 60-100 caracteres que reflete o ASSUNTO CENTRAL do artigo. NÃO copie headers, números de página, nomes de revistas ou afiliações institucionais. Pense: "qual é o tema único deste artigo?" e escreva como um título de capítulo.

- theme: um de exatamente: ${TAXONOMY.join(' | ')}.
  Use as descrições abaixo pra guiar:
${descriptions}

- summary: string de até 200 caracteres com uma única frase resumindo a contribuição central do artigo. Sem chavões, sem "este artigo discute".

Não inclua explicações fora do JSON. Responda EXCLUSIVAMENTE com o objeto.`;
}

export async function classifyContent(
  text: string,
  filename: string,
): Promise<ClassifyResult> {
  console.info(`[ingest/classify] sending text bytes=${text.length} filename=${filename}`);

  const truncated = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const ai = getOpenAI();
    const res = await ai.chat.completions.create(
      {
        model: getOpenAIModel(),
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: truncated },
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 400,
      },
      { signal: controller.signal },
    );

    const raw = res.choices[0]?.message?.content ?? '';
    const parsed = ClassifyResultSchema.parse(JSON.parse(raw));

    if (!isValidTheme(parsed.theme)) {
      console.warn(`[ingest/classify] fallback for ${filename}: invalid theme "${parsed.theme}"`);
      return fallback(filename);
    }

    const title = stripWrappingQuotes(parsed.title);
    if (title.length < 10) {
      console.warn(`[ingest/classify] fallback for ${filename}: title too short ("${title}")`);
      return fallback(filename);
    }

    const summary = (parsed.summary ?? '').trim().slice(0, 220);
    const result: ClassifyResult = { title, theme: parsed.theme as Theme, summary };
    console.info(`[ingest/classify] result title="${title}" theme=${result.theme}`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ingest/classify] fallback for ${filename}: ${message}`);
    return fallback(filename);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/lib/ingest/classify-content.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/ingest/classify-content.ts tests/lib/ingest/classify-content.test.ts
git commit -m "$(cat <<'EOF'
feat(ingest): classifyContent calls gpt-4o-mini for title+theme+summary

OpenAI chat.completions with response_format json_object + zod validation.
Fails soft to filename-stem fallback on any error (network, timeout,
invalid JSON, theme outside taxonomy, title <10 chars). Hard 15s abort
timeout. Truncates input at 6000 chars to bound token cost.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Pipeline integration (dedup-first reorder)

The pipeline currently parses → chunks → extractMetadata → dedup-check → insert. Sub-projeto 13 inserts `classifyContent` AFTER the dedup check (so duplicate uploads don't burn OpenAI tokens) and BEFORE the article insert. Existing `extractMetadata` keeps running for `author`/`language`/`date` only — its `title` field is ignored.

**Files:**
- Modify: `lib/ingest/pipeline.ts`
- Modify: `tests/lib/ingest/pipeline.test.ts`

- [ ] **Step 1: Read current `lib/ingest/pipeline.ts`** to confirm the dedup check + insert section. The flow today (sub-projeto 12) is:

```
parseSource → chunkRows → sourceText → extractMetadata → sha256 → dedup check
  → if existing: return done with deduplicated stage
  → else: insert article { title: meta.title, ..., metadata: { parser } }
```

We will:
1. Move dedup check earlier (right after `sourceText` is built).
2. Call `classifyContent(sourceText, job.filename)` AFTER dedup miss.
3. Use `classified.title`, `classified.theme`, `classified.summary` in the insert.
4. Keep `meta.author`, `meta.language`, `meta.date` from `extractMetadata`.

- [ ] **Step 2: Apply the reorder + integration**

In `lib/ingest/pipeline.ts`, locate the block that currently builds `sourceText`, calls `extractMetadata`, computes `hash`, runs the dedup check, and inserts the article. Replace with:

```ts
const sourceText =
  parsed.kind === 'text'
    ? parsed.text
    : parsed.blocks
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.content)
        .join('\n\n');

// Dedup BEFORE classifyContent — saves OpenAI tokens on repeat uploads.
const hash = sha256(blob);
const { data: existing } = await sb
  .from('articles')
  .select('id')
  .eq('metadata->>content_hash', hash)
  .maybeSingle();

if (existing) {
  await deleteFromIngestBucket(job.storage_path);
  await update({
    status: 'done',
    stage: 'deduplicated',
    progress: 100,
    chunks_count: 0,
    article_id: existing.id,
    finished_at: new Date().toISOString(),
  });
  return;
}

// Dedup miss: classify, then insert.
await update({ stage: 'classifying', progress: 30 });
const classified = await classifyContent(sourceText, job.filename);
const meta = extractMetadata(sourceText, job.filename);
// Note: classified.title is used; meta.title is ignored (sub-projeto 13).

const { data: article, error: insArtErr } = await sb
  .from('articles')
  .insert({
    title: classified.title,
    theme: classified.theme,
    summary: classified.summary,
    author: meta.author,
    language: meta.language,
    published_at: meta.date,
    source_chars: sourceText.length,
    raw_md: sourceText,
    metadata: {
      content_hash: hash,
      source_filename: job.filename,
      parser,
    },
  })
  .select('id')
  .single();
if (insArtErr || !article) {
  throw new Error(`article insert failed: ${insArtErr?.message ?? 'no row'}`);
}
```

Add `import { classifyContent } from '@/lib/ingest/classify-content';` at the top.

The `'classifying'` stage is informational; the `ingestion_jobs.stage` column already accepts arbitrary text. No DB change needed for the stage label.

- [ ] **Step 3: Update `tests/lib/ingest/pipeline.test.ts`**

The existing test mocks `@/lib/ingest/parse-source` (sub-projeto 12). Add a mock for `@/lib/ingest/classify-content` and add 2 new tests + adjust 2 existing.

Insert this mock helper just below the existing `vi.doMock('@/lib/ingest/parse-source', ...)` calls inside `setupMocks`:

```ts
  vi.doMock('@/lib/ingest/classify-content', () => ({
    classifyContent: vi.fn().mockImplementation(async () => ({
      title: opts.classifyTitle ?? 'A meaningful title from LLM',
      theme: opts.classifyTheme ?? 'Outros',
      summary: opts.classifySummary ?? 'one-line summary',
    })),
  }));
```

Add `classifyTitle?: string; classifyTheme?: string; classifySummary?: string` to the `setupMocks` opts type.

Also add a way to assert `classifyContent` was NOT called on dedup hits:

```ts
  // ... after the existing classify mock
  return { updateCalls, insertedArticles, insertedChunkBatches };
```

Replace `return { updateCalls, insertedArticles, insertedChunkBatches }` with:

```ts
  const classifyContentMod = await import('@/lib/ingest/classify-content');
  return {
    updateCalls,
    insertedArticles,
    insertedChunkBatches,
    classifyContent: classifyContentMod.classifyContent as ReturnType<typeof vi.fn>,
  };
```

(NOTE: this requires the helper to be `async function setupMocks(...)` — adjust the signature accordingly.)

Two new tests:

```ts
  it('uses classifyContent.title/theme/summary on the article insert (dedup miss)', async () => {
    const m = await setupMocks({
      job: baseJob,
      classifyTitle: 'Aplicação prática da matriz de Kraljic',
      classifyTheme: 'Kraljic',
      classifySummary: 'Caso aplicado a varejo de alimentos',
    });
    const { runPipeline } = await import('@/lib/ingest/pipeline');
    await runPipeline('job-1');
    const row = m.insertedArticles[0] as Record<string, unknown>;
    expect(row.title).toBe('Aplicação prática da matriz de Kraljic');
    expect(row.theme).toBe('Kraljic');
    expect(row.summary).toBe('Caso aplicado a varejo de alimentos');
  });

  it('does NOT call classifyContent on dedup hit', async () => {
    const m = await setupMocks({ job: baseJob, existingArticleId: 'existing-art-9' });
    const { runPipeline } = await import('@/lib/ingest/pipeline');
    await runPipeline('job-1');
    expect(m.classifyContent).not.toHaveBeenCalled();
  });
```

Update the existing happy-path test (`'happy path text fallback: writes article, embeds chunks, marks done'`) to no longer assert `title` directly (the value now comes from the classify mock default `'A meaningful title from LLM'`). The other assertions (status=done, chunks_count > 0) keep working.

- [ ] **Step 4: Run pipeline tests**

Run: `npm test -- tests/lib/ingest/pipeline.test.ts`
Expected: PASS — should now have ~8 tests (6 existing + 2 new).

- [ ] **Step 5: Run full vitest to catch any regression**

Run: `npm test`
Expected: PASS (around 287 tests after Task 11 lands; at this checkpoint expect roughly current_count + 17 from Tasks 2/3/4 — taxonomy 5, classify 10, pipeline +2).

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add lib/ingest/pipeline.ts tests/lib/ingest/pipeline.test.ts
git commit -m "$(cat <<'EOF'
feat(ingest): pipeline calls classifyContent after dedup, before insert

Reorders sourceText → dedup-check → classifyContent → insert. Dedup
hits skip the OpenAI call entirely (zero token waste on repeats). The
classified title/theme/summary are written to the new columns;
extractMetadata still runs for author/language/date.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: PATCH endpoint for admin override

Extend `app/api/admin/articles/[id]/route.ts` with a `PATCH` handler so admin can edit title and/or theme inline. zod validates: title 3-200 chars, theme must be in TAXONOMY, at least one of the two present.

**Files:**
- Modify: `app/api/admin/articles/[id]/route.ts`
- Create: `tests/api/admin/articles-patch.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/api/admin/articles-patch.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

class NotAdminError extends Error {
  constructor() {
    super('not admin');
    this.name = 'NotAdmin';
  }
}

function setupMocks(opts: { isAdmin: boolean; supabaseError?: { message: string } | null }) {
  const updateChain = {
    eq: vi.fn().mockResolvedValue({ error: opts.supabaseError ?? null }),
  };
  const update = vi.fn().mockReturnValue(updateChain);
  vi.doMock('@/lib/auth', () => {
    class NotAdmin extends Error {
      constructor() { super('not admin'); this.name = 'NotAdmin'; }
    }
    return {
      requireAdmin: vi.fn().mockImplementation(() => {
        if (!opts.isAdmin) throw new NotAdmin();
      }),
      NotAdmin,
    };
  });
  vi.doMock('@/lib/db/supabase-server', () => ({
    supabaseServer: () => ({ from: () => ({ update }) }),
  }));
  return { update, updateChain };
}

function buildReq(body: unknown): Request {
  return new Request('http://x/api/admin/articles/abc', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/admin/articles/[id]', () => {
  it('returns 404 for non-admin', async () => {
    setupMocks({ isAdmin: false });
    const { PATCH } = await import('@/app/api/admin/articles/[id]/route');
    const res = await PATCH(buildReq({ title: 'New title here' }), { params: { id: 'abc' } });
    expect(res.status).toBe(404);
  });

  it('returns 400 when body is empty (no fields)', async () => {
    setupMocks({ isAdmin: true });
    const { PATCH } = await import('@/app/api/admin/articles/[id]/route');
    const res = await PATCH(buildReq({}), { params: { id: 'abc' } });
    expect(res.status).toBe(400);
  });

  it('returns 400 when theme is outside taxonomy', async () => {
    setupMocks({ isAdmin: true });
    const { PATCH } = await import('@/app/api/admin/articles/[id]/route');
    const res = await PATCH(buildReq({ theme: 'BogusTheme' }), { params: { id: 'abc' } });
    expect(res.status).toBe(400);
  });

  it('returns 400 when title is too short', async () => {
    setupMocks({ isAdmin: true });
    const { PATCH } = await import('@/app/api/admin/articles/[id]/route');
    const res = await PATCH(buildReq({ title: 'ab' }), { params: { id: 'abc' } });
    expect(res.status).toBe(400);
  });

  it('updates with title only', async () => {
    const m = setupMocks({ isAdmin: true });
    const { PATCH } = await import('@/app/api/admin/articles/[id]/route');
    const res = await PATCH(
      buildReq({ title: 'Title that is long enough' }),
      { params: { id: 'abc' } },
    );
    expect(res.status).toBe(200);
    expect(m.update).toHaveBeenCalledWith({ title: 'Title that is long enough' });
  });

  it('updates with theme only', async () => {
    const m = setupMocks({ isAdmin: true });
    const { PATCH } = await import('@/app/api/admin/articles/[id]/route');
    const res = await PATCH(buildReq({ theme: 'Kraljic' }), { params: { id: 'abc' } });
    expect(res.status).toBe(200);
    expect(m.update).toHaveBeenCalledWith({ theme: 'Kraljic' });
  });

  it('returns 500 when supabase update errors', async () => {
    setupMocks({ isAdmin: true, supabaseError: { message: 'boom' } });
    const { PATCH } = await import('@/app/api/admin/articles/[id]/route');
    const res = await PATCH(buildReq({ theme: 'Kraljic' }), { params: { id: 'abc' } });
    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/api/admin/articles-patch.test.ts`
Expected: FAIL with "PATCH is not a function" (route exports only DELETE today).

- [ ] **Step 3: Add PATCH to `app/api/admin/articles/[id]/route.ts`**

Append to the file (do NOT remove the existing DELETE handler):

```ts
import { z } from 'zod';
import { isValidTheme } from '@/lib/ingest/taxonomy';

const PatchBody = z
  .object({
    title: z.string().min(3).max(200).optional(),
    theme: z.string().refine(isValidTheme, { message: 'invalid theme' }).optional(),
  })
  .refine((b) => b.title !== undefined || b.theme !== undefined, {
    message: 'at least one field required',
  });

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof NotAdmin) return new NextResponse('Not Found', { status: 404 });
    throw err;
  }

  let body: z.infer<typeof PatchBody>;
  try {
    const json = await req.json();
    body = PatchBody.parse(json);
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const sb = supabaseServer();
  const { error } = await sb.from('articles').update(body).eq('id', params.id);
  if (error) return NextResponse.json({ error: 'update_failed' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/api/admin/articles-patch.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/api/admin/articles/\[id\]/route.ts tests/api/admin/articles-patch.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): PATCH /api/admin/articles/[id] for title/theme override

zod-validated body { title?: string (3-200), theme?: TAXONOMY enum };
at least one field required. Gates on requireAdmin (404 for non-admin).
Returns 200 on success, 400 on body fail, 500 on supabase error.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: ThemeSidebar component

Vertical list of buttons: `Todos` (count = all articles) + a divider + the 11 themes (each with count). Clicking selects that theme; the parent filters its article list.

**Files:**
- Create: `components/admin/ThemeSidebar.tsx`
- Create: `tests/components/admin/ThemeSidebar.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `tests/components/admin/ThemeSidebar.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeSidebar } from '@/components/admin/ThemeSidebar';
import { TAXONOMY } from '@/lib/ingest/taxonomy';

const articles = [
  { theme: 'Kraljic' },
  { theme: 'Kraljic' },
  { theme: 'TCO' },
  { theme: 'Outros' },
] as Array<{ theme: string }>;

describe('ThemeSidebar', () => {
  it('renders Todos + 11 themes (12 buttons total)', () => {
    render(<ThemeSidebar articles={articles} selected="all" onSelect={() => {}} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(12);
  });

  it('shows correct counts per theme', () => {
    render(<ThemeSidebar articles={articles} selected="all" onSelect={() => {}} />);
    expect(screen.getByText('Todos').closest('button')?.textContent).toContain('4');
    expect(screen.getByText('Kraljic').closest('button')?.textContent).toContain('2');
    expect(screen.getByText('TCO').closest('button')?.textContent).toContain('1');
    expect(screen.getByText('Outros').closest('button')?.textContent).toContain('1');
    // Themes with 0 articles still render with count 0
    expect(screen.getByText('SRM').closest('button')?.textContent).toContain('0');
  });

  it('marks the selected theme as active (aria-current)', () => {
    render(<ThemeSidebar articles={articles} selected="Kraljic" onSelect={() => {}} />);
    const kraljic = screen.getByText('Kraljic').closest('button');
    expect(kraljic?.getAttribute('aria-current')).toBe('true');
    const todos = screen.getByText('Todos').closest('button');
    expect(todos?.getAttribute('aria-current')).toBeFalsy();
  });

  it('fires onSelect with the clicked theme', () => {
    const onSelect = vi.fn();
    render(<ThemeSidebar articles={articles} selected="all" onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Kraljic').closest('button')!);
    expect(onSelect).toHaveBeenCalledWith('Kraljic');
    fireEvent.click(screen.getByText('Todos').closest('button')!);
    expect(onSelect).toHaveBeenCalledWith('all');
  });

  it('renders all TAXONOMY themes in order', () => {
    render(<ThemeSidebar articles={[]} selected="all" onSelect={() => {}} />);
    for (const t of TAXONOMY) {
      expect(screen.getByText(t)).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/components/admin/ThemeSidebar.test.tsx`
Expected: FAIL with "Cannot find module '@/components/admin/ThemeSidebar'"

- [ ] **Step 3: Implement `components/admin/ThemeSidebar.tsx`**

```tsx
'use client';

import { useMemo } from 'react';
import { TAXONOMY, type Theme } from '@/lib/ingest/taxonomy';

export type ThemeFilter = Theme | 'all';

type Props = {
  articles: Array<{ theme: string }>;
  selected: ThemeFilter;
  onSelect: (t: ThemeFilter) => void;
};

export function ThemeSidebar({ articles, selected, onSelect }: Props) {
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    map.set('all', articles.length);
    for (const t of TAXONOMY) map.set(t, 0);
    for (const a of articles) {
      if (TAXONOMY.includes(a.theme as Theme)) {
        map.set(a.theme, (map.get(a.theme) ?? 0) + 1);
      }
    }
    return map;
  }, [articles]);

  return (
    <nav className="border-r border-border p-2 space-y-0.5 text-sm bg-muted/30">
      <ThemeButton
        label="Todos"
        count={counts.get('all') ?? 0}
        active={selected === 'all'}
        onClick={() => onSelect('all')}
      />
      <div className="h-px bg-border my-1" />
      {TAXONOMY.map((t) => (
        <ThemeButton
          key={t}
          label={t}
          count={counts.get(t) ?? 0}
          active={selected === t}
          onClick={() => onSelect(t)}
        />
      ))}
    </nav>
  );
}

function ThemeButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const base = 'flex items-center justify-between w-full px-2 py-1.5 rounded text-left transition-colors';
  const colors = active ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-accent';
  const dim = count === 0 && !active ? 'text-muted-foreground' : '';
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
      className={`${base} ${colors} ${dim}`}
    >
      <span className="truncate">{label}</span>
      <span className="text-xs text-muted-foreground tabular-nums ml-2">{count}</span>
    </button>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/components/admin/ThemeSidebar.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add components/admin/ThemeSidebar.tsx tests/components/admin/ThemeSidebar.test.tsx
git commit -m "$(cat <<'EOF'
feat(admin): ThemeSidebar component (Todos + 11 themes + counts)

Vertical nav button list. aria-current on the active item, dimmed
muted color for themes with zero articles. Pure presentational —
parent owns the selected state and applies the filter.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: ArticlesSplitView 3-column + theme filter

Wire `<ThemeSidebar>` into the existing 2-column split view. Layout becomes 3-col: `[180px sidebar | 1.4fr list | 1fr detail]`. Filter the article list by the selected theme. Fetch must include `theme` and `summary` columns.

**Files:**
- Modify: `components/admin/ArticlesSplitView.tsx`

- [ ] **Step 1: Update the component**

Read the current file to confirm shape, then apply these changes:

1. **Add imports + types:**
```tsx
import { ThemeSidebar, type ThemeFilter } from '@/components/admin/ThemeSidebar';
```

2. **Extend `AdminArticle` type** (in `components/admin/ArticleDetail.tsx` — co-modify):

Add to `AdminArticle`:
```ts
theme: string;
summary: string | null;
```

3. **Extend the select call** to include `theme, summary`:
```ts
.select('id, title, author, language, published_at, ingested_at, metadata, source_chars, theme, summary')
```

4. **Add filter state:**
```ts
const [themeFilter, setThemeFilter] = useState<ThemeFilter>('all');
```

5. **Apply the filter inside the existing `filtered` memo** (BEFORE the search filter):
```ts
const filtered = useMemo(() => {
  let out = themeFilter === 'all' ? rows : rows.filter((r) => r.theme === themeFilter);
  if (search.trim()) {
    const q = search.toLowerCase();
    out = out.filter(
      (r) => r.title.toLowerCase().includes(q) || (r.author ?? '').toLowerCase().includes(q),
    );
  }
  return out;
}, [rows, search, themeFilter]);
```

6. **Wrap the existing 2-col grid in a 3-col grid** (left side becomes the sidebar):

Replace the existing `<div className="grid grid-cols-[1.4fr_1fr] gap-0 ...">` with:

```tsx
<div className="grid grid-cols-[180px_1.4fr_1fr] gap-0 rounded-md border border-border overflow-hidden bg-card min-h-[420px]">
  <div className="max-h-[600px] overflow-y-auto">
    <ThemeSidebar articles={rows} selected={themeFilter} onSelect={setThemeFilter} />
  </div>
  <div className="border-r border-l border-border max-h-[600px] overflow-y-auto">
    {/* existing list table goes here, unchanged */}
  </div>
  <div className="bg-background">
    <ArticleDetail
      article={selected}
      onDeleted={(id) => {
        setRows((prev) => prev.filter((r) => r.id !== id));
        setSelected((prev) => (prev?.id === id ? null : prev));
        setSelectedId(null);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }}
      onUpdated={(id, patch) => {
        setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
      }}
    />
  </div>
</div>
```

7. **The bulk-delete confirm dialog and the multi-select header above the table stay as-is**, but they now operate on the theme-filtered list (which is already what `filtered` is doing).

- [ ] **Step 2: Update `AdminArticle` type and ArticleDetail's onUpdated prop**

In `components/admin/ArticleDetail.tsx`, extend the type:

```ts
export type AdminArticle = {
  id: string;
  title: string;
  author: string | null;
  language: string;
  published_at: string | null;
  metadata: Record<string, unknown>;
  ingested_at: string;
  source_chars: number;
  theme: string;
  summary: string | null;
};
```

Add to the `Props`:

```ts
type Props = {
  article: AdminArticle | null;
  onDeleted: (id: string) => void;
  onUpdated?: (id: string, patch: { title?: string; theme?: string }) => void;
};
```

(`onUpdated` is implemented in Task 8; leave it optional for now so this task can land green.)

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Run vitest (no new tests, just no regression)**

Run: `npm test`
Expected: PASS — the existing component tests for `<ArticleDetail>` still pass with the unused `onUpdated` prop.

- [ ] **Step 5: Manual smoke (optional but recommended)**

```bash
npm run dev
```

Open http://localhost:3000/admin/articles. Confirm:
- Sidebar appears on the left with 12 buttons (Todos + 11 themes).
- Clicking a theme filters the table.
- "Todos" shows everything.
- Multi-select + bulk delete still work inside the filter.
- The detail pane on the right works as before.

(Existing 3 articles will all be in `Outros` until Task 9 backfill runs.)

- [ ] **Step 6: Commit**

```bash
git add components/admin/ArticlesSplitView.tsx components/admin/ArticleDetail.tsx
git commit -m "$(cat <<'EOF'
feat(admin): 3-col layout with ThemeSidebar in /admin/articles

Adds the theme filter sidebar; layout grid becomes [180px | 1.4fr | 1fr].
Article list fetches the new theme/summary columns and filters by the
selected theme (default 'all'). onUpdated callback wired up for the
inline edit work in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: ArticleDetail editable title + theme dropdown + summary

The detail pane gains: (a) `summary` rendered under the title in italic muted text, (b) pencil button on the title that toggles to an input with Save/Cancel, (c) theme dropdown above the chunks block. Both inputs PATCH the article and call `onUpdated` so the parent updates `rows` state.

**Files:**
- Modify: `components/admin/ArticleDetail.tsx`

- [ ] **Step 1: Add the `EditableTitle` inline component + theme dropdown + summary render**

Replace the existing title block (currently `<h3>{article.title}</h3>` etc., around lines 88-100) and the existing `<div className="flex gap-2">` action row, with:

```tsx
import { TAXONOMY, isValidTheme } from '@/lib/ingest/taxonomy';
import { toast } from 'sonner';

// ... inside the component, add state:
const [editingTitle, setEditingTitle] = useState(false);
const [titleDraft, setTitleDraft] = useState(article?.title ?? '');
const [savingPatch, setSavingPatch] = useState(false);

// reset drafts when article changes
useEffect(() => {
  setTitleDraft(article?.title ?? '');
  setEditingTitle(false);
}, [article?.id]);

async function patchArticle(patch: { title?: string; theme?: string }) {
  if (!article) return;
  setSavingPatch(true);
  try {
    const res = await fetch(`/api/admin/articles/${article.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    onUpdated?.(article.id, patch);
    toast.success('Atualizado');
  } catch (err) {
    toast.error('Falha ao salvar', { description: String(err) });
  } finally {
    setSavingPatch(false);
  }
}
```

Replace the existing header block (above the action row) with:

```tsx
<div>
  {editingTitle ? (
    <div className="flex gap-1.5 items-start">
      <Input
        value={titleDraft}
        onChange={(e) => setTitleDraft(e.target.value)}
        className="text-sm"
        autoFocus
      />
      <Button
        size="sm"
        onClick={async () => {
          const t = titleDraft.trim();
          if (t.length < 3) {
            toast.error('Título precisa ter ao menos 3 caracteres');
            return;
          }
          await patchArticle({ title: t });
          setEditingTitle(false);
        }}
        disabled={savingPatch}
      >
        Salvar
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setTitleDraft(article.title);
          setEditingTitle(false);
        }}
      >
        Cancelar
      </Button>
    </div>
  ) : (
    <div className="flex items-start gap-1.5">
      <h3 className="text-sm font-semibold flex-1">{article.title}</h3>
      <button
        type="button"
        aria-label="Editar título"
        title="Editar título"
        onClick={() => setEditingTitle(true)}
        className="text-muted-foreground hover:text-foreground p-0.5"
      >
        ✎
      </button>
    </div>
  )}
  {article.summary && (
    <p className="text-xs text-muted-foreground italic mt-1">{article.summary}</p>
  )}
  <p className="text-xs text-muted-foreground mt-1">
    {[article.author, article.language?.toUpperCase(), article.published_at, hash ? `SHA: ${hash.slice(0, 8)}…` : null]
      .filter(Boolean)
      .join(' · ')}
  </p>
  <p className="text-xs text-muted-foreground mt-1">
    {chunks.length} chunks · ≈{absorvedPct}% absorvido
  </p>
  <div className="mt-2 flex items-center gap-2">
    <label className="text-xs text-muted-foreground">Tema:</label>
    <select
      value={isValidTheme(article.theme) ? article.theme : 'Outros'}
      onChange={(e) => patchArticle({ theme: e.target.value })}
      disabled={savingPatch}
      className="text-xs rounded border border-border bg-background px-2 py-1"
    >
      {TAXONOMY.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  </div>
</div>
```

Add `Input` to imports (`@/components/ui/input`) if not already imported.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run full vitest to confirm no regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Manual smoke**

```bash
npm run dev
```

Open `/admin/articles`, select an article. Confirm:
- Pencil ✎ next to title; click → inline input + Save/Cancel.
- Save with empty title → toast error; theme dropdown shows current value.
- Change theme → article moves to that theme's bucket; sidebar count updates.
- Refresh F5 → changes persist.

- [ ] **Step 5: Commit**

```bash
git add components/admin/ArticleDetail.tsx
git commit -m "$(cat <<'EOF'
feat(admin): inline edit title + theme dropdown + summary in ArticleDetail

Pencil button toggles the title to an input with Save/Cancel. Theme
dropdown lists the 11 TAXONOMY values; change fires PATCH and calls
onUpdated so the parent re-counts. Summary renders below the title in
italic muted text when non-empty. sonner toasts on success and failure.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Reclassify backfill script

CLI that reads every article from the DB, calls `classifyContent` against `articles.raw_md`, and writes `title`/`theme`/`summary` back. Idempotent — re-running overwrites with whatever the LLM produces. `--dry-run` flag prints what it WOULD do without writing.

**Files:**
- Create: `scripts/reclassify.ts`
- Modify: `package.json`

- [ ] **Step 1: Write `scripts/reclassify.ts`**

```ts
#!/usr/bin/env tsx
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '@/lib/db/supabase';
import { classifyContent } from '@/lib/ingest/classify-content';
import { TAXONOMY } from '@/lib/ingest/taxonomy';

type ArticleRow = {
  id: string;
  title: string;
  raw_md: string | null;
  metadata: Record<string, unknown> | null;
};

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const sb = getServerSupabase();

  const { data, error } = await sb
    .from('articles')
    .select('id, title, raw_md, metadata')
    .order('ingested_at', { ascending: true });
  if (error) {
    console.error(`[reclassify] supabase select failed: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as ArticleRow[];
  console.log(`[reclassify] processing ${rows.length} articles${dryRun ? ' (dry-run)' : ''}`);

  const counts: Record<string, number> = {};
  for (const t of TAXONOMY) counts[t] = 0;
  let failed = 0;

  for (const row of rows) {
    const filename = (row.metadata?.['source_filename'] as string | undefined) ?? row.id;
    if (!row.raw_md || row.raw_md.trim().length < 100) {
      console.warn(`[reclassify] skip ${row.id.slice(0, 8)} — empty raw_md`);
      failed++;
      continue;
    }
    try {
      const c = await classifyContent(row.raw_md, filename);
      console.log(
        `[reclassify] ${row.id.slice(0, 8)} → "${c.title.slice(0, 60)}" / ${c.theme}`,
      );
      counts[c.theme] = (counts[c.theme] ?? 0) + 1;
      if (!dryRun) {
        const { error: upErr } = await sb
          .from('articles')
          .update({ title: c.title, theme: c.theme, summary: c.summary })
          .eq('id', row.id);
        if (upErr) {
          console.error(`[reclassify] update failed for ${row.id}: ${upErr.message}`);
          failed++;
        }
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[reclassify] classify failed for ${row.id}: ${m}`);
      failed++;
    }
  }

  console.log('\n[reclassify] summary by theme:');
  for (const t of TAXONOMY) {
    console.log(`  ${t.padEnd(28, ' ')} ${counts[t] ?? 0}`);
  }
  console.log(`  failed/skipped: ${failed}`);
}

main().catch((err) => {
  console.error('[reclassify] fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `package.json`, in the `scripts` object, add:

```json
    "articles:reclassify": "tsx scripts/reclassify.ts"
```

(Keep the existing scripts unchanged.)

- [ ] **Step 3: Run dry-run to verify it doesn't write**

```bash
npm run articles:reclassify -- --dry-run
```

Expected output: prints classify result for each of the 3 existing articles + a summary table. No writes.

- [ ] **Step 4: Run for real**

```bash
npm run articles:reclassify
```

Expected: each article gets new title/theme/summary. Verify via psycopg:

```bash
scripts/.venv/Scripts/python.exe -c "
import os, psycopg
from pathlib import Path
env_path = Path('.env.local')
for line in env_path.read_text(encoding='utf-8').splitlines():
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line: continue
    k, v = line.split('=', 1)
    os.environ.setdefault(k.strip(), v.strip().strip(chr(34)).strip(chr(39)))
url = os.environ['NEXT_PUBLIC_SUPABASE_URL']
host = url.replace('https://','').replace('.supabase.co','') + '.supabase.co'
conn = psycopg.connect(f'postgresql://postgres:{os.environ[\"SUPABASE_DB_PASSWORD\"]}@db.{host}:5432/postgres', autocommit=True)
with conn.cursor() as cur:
    cur.execute(\"select id, title, theme, summary from articles order by ingested_at desc\")
    for row in cur.fetchall(): print(row)
conn.close()
"
```

Save the printed titles — Task 11 needs them.

- [ ] **Step 5: Commit**

```bash
git add scripts/reclassify.ts package.json
git commit -m "$(cat <<'EOF'
feat(scripts): articles:reclassify backfills title+theme+summary via raw_md

CLI reads every article, calls classifyContent on the stored raw_md
(no re-upload needed), and updates the row. --dry-run prints results
without writing. Loop is per-article so a single failure doesn't kill
the rest. Prints a final breakdown by theme.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Realign golden.json with the new canonical titles

The 25 pre-existing golden queries reference titles that the LLM probably won't reproduce verbatim (e.g., the LLM is unlikely to call an article exactly `"A Matriz de Kraljic"` even if its content is about Kraljic). The eval gate `recall@5 ≥ 0.85` will fail on pre-existing pairs until their `expected_titles` are updated to whatever the LLM-derived titles actually became after Task 9.

This task is **manual judgment** — you map old → new titles using the output saved in Task 9.

**Files:**
- Modify: `scripts/eval/golden.json`

- [ ] **Step 1: Read the current golden + the new article titles**

Read `scripts/eval/golden.json`. Run the psycopg query from Task 9 step 4 to get the current titles in the DB.

- [ ] **Step 2: Map old → new titles**

For each entry whose `expected_titles` references one of the old titles (e.g., `"A Matriz de Kraljic"`), replace it with whatever the LLM produced for that same article. Identify the article via content (Kraljic article → new Kraljic-shaped title; Sustentáveis article → new Sustentáveis-shaped title; etc.).

If the LLM produced very different titles per article and you can't easily tell which is which, fall back to per-id lookup: open `/admin/articles`, look at each article (you can sort by `ingested_at`), and copy its title.

- [ ] **Step 3: Run rag:eval**

```bash
npm run rag:eval
```

Expected: `recall@5 ≥ 0.85` over 30 pairs.

If recall is below threshold, inspect the table that the eval prints (`hit | rank | latency_ms`):
- `inconclusive` rows mean title→ID lookup failed (typo in the new title — fix).
- `miss` rows mean the article didn't rank top 5 (real retrieval issue — should be rare; if persistent, the new title may be too short/generic; consider a manual title override via PATCH).

- [ ] **Step 4: Commit**

```bash
git add scripts/eval/golden.json
git commit -m "$(cat <<'EOF'
chore(eval): realign golden expected_titles with LLM-derived names

Sub-projeto 13's classifier produces new canonical titles for the 4
corpus articles; the 30 golden pairs now reference those names so
recall@5 stays above the 0.85 gate. Mapping was per-article (manual
judgment using the new titles stored in articles.title after the
articles:reclassify run).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Smoke doc + CLAUDE.md + tag

Closing task — documentation + version tag.

**Files:**
- Modify: `docs/product/beta-smoke-test.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append smoke section to `docs/product/beta-smoke-test.md`**

Append a new section at the end of the file:

```markdown

### Sub-projeto 13 — Auto-classified Library

- [ ] Re-uploadar 1 PDF qualquer: `/admin/articles` mostra título coerente com o conteúdo (não header de journal) e tema correto na coluna esquerda (sidebar atualiza contagem).
- [ ] Sidebar `/admin/articles`: clicar num tema com 0 artigos → tabela vazia (mensagem "Nenhum artigo neste tema" ou simplesmente vazio).
- [ ] Editar título via lápis no detail pane: persiste após F5 e o card na lista atualiza.
- [ ] Editar tema via dropdown: artigo "muda de pasta" — sidebar contagens recalculam imediatamente sem refetch.
- [ ] Tentar setar tema fora da taxonomia (dev tools, fetch direto): API retorna 400.
```

- [ ] **Step 2: Update CLAUDE.md**

Add a row to the "Status — sub-projetos completos" table:

```markdown
| 13 | `auto-classified-library-complete` | Pipeline chama `classifyContent` (gpt-4o-mini, fail-soft, abort 15s) após dedup-check pra produzir `{ title, theme, summary }` baseados no conteúdo. Migration 0010 adiciona `articles.theme` (CHECK constraint nos 11 valores) + `articles.summary`. `lib/ingest/taxonomy.ts` é a fonte única da verdade pra os temas. `/admin/articles` ganha sidebar de temas (180px) com contagem; detail pane ganha `<EditableTitle>` (lápis ✎) + dropdown de tema; PATCH `/api/admin/articles/[id]` valida com zod. Script `npm run articles:reclassify` re-classifica todos os artigos via `articles.raw_md` (sem re-upload). `golden.json` realinhado pros novos títulos canônicos pós-backfill. |
```

Add to the "## O que evitar" section, at the appropriate place:

```markdown
- Adicionar tema na taxonomia editando só `lib/ingest/taxonomy.ts` — a CHECK constraint no DB também precisa ser atualizada via migration. Os dois lugares precisam estar em sync, senão `update articles set theme=...` quebra com check_violation.
- Chamar `classifyContent` ANTES do dedup check no `pipeline.ts` — o ordering correto é dedup → classify → insert (sub-projeto 13 deliberadamente reordenou pra economizar OpenAI em re-uploads do mesmo PDF).
- Confiar no `extractMetadata.title` em código novo — sub-projeto 13 ignora esse campo (`articles.title` agora vem do `classifyContent`). `extractMetadata` segue válido pra `author`/`language`/`date`.
- Persistir tema em `chunks.metadata` — o tema é puramente administrativo (organização da biblioteca), NÃO é usado pelo retrieval. Adicionar no chunk seria duplicação inútil.
- Editar `golden.json` `expected_titles` sem rodar `npm run articles:reclassify` antes — você não sabe quais títulos canônicos o LLM produziu até rodar o backfill.
- Usar `articles.title` como ID estável em qualquer integração externa — o admin pode editar via PATCH a qualquer momento. Use `articles.id` (UUID).
```

Update the "## Estrutura de pastas" section under `/lib/ingest`:

```
  /ingest                               (TS port da pipeline; scripts/ingest.py mantido como legacy)
    types.ts                            (JobStatus, JobStage, IngestJob, Block, ParsedSource, ChunkKind, ChunkRow)
    hash.ts                             (sha256 helper)
    parser.ts                           (parsePdfTextOnly + parseDocxTextOnly + parseTxt; parseFile @deprecated mime-dispatch wrapper)
    multimodal-parse.ts                 (parsePdfMultimodal: Gemini multimodal, inline + Files API via ai.files.upload, zod retry, abort 120s)
    docx-parse.ts                       (parseDocxWithTables: mammoth.convertToHtml + table extraction)
    html-table.ts                       (htmlTableToMarkdown utility)
    parse-source.ts                     (parseSource dispatcher: PDF→multimodal-with-fallback, DOCX→tables-aware, TXT→trivial)
    chunker.ts                          (chunkText + chunkBlocks; paragraph-aware splitter shared internally)
    metadata.ts                         (author/language/date heurísticas; title campo ignorado pós-sub-projeto 13)
    taxonomy.ts                         (TAXONOMY 11 temas + Theme type + isValidTheme + THEME_DESCRIPTIONS)
    classify-content.ts                 (classifyContent: gpt-4o-mini, response_format json_object, zod, fail-soft, abort 15s)
    pipeline.ts                         (runPipeline: dedup → classify → insert, ordering reorder em sub-projeto 13)
```

- [ ] **Step 3: Run final CI gate locally**

```bash
npm run typecheck
npm test
npm run rag:eval
```

Expected: all PASS; vitest ~287, recall@5 ≥ 0.85 over 30 pairs.

- [ ] **Step 4: Commit docs**

```bash
git add docs/product/beta-smoke-test.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(CLAUDE.md): record sub-projeto 13 (auto-classified library)

Captures the classifyContent pipeline, taxonomy as single source of
truth (TS + DB CHECK), admin override via PATCH, and the explicit
non-decisions (theme not in chunks; title is mutable via PATCH).
Smoke test adds 5 manual checks for the new sidebar + edit flow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Push and tag**

```bash
git push origin main
git tag auto-classified-library-complete
git push origin auto-classified-library-complete
```

- [ ] **Step 6: Verify CI green on the push**

Open the GitHub Actions tab for the latest commit on `main` and confirm:
- typecheck ✓
- vitest ✓
- pytest ✓ (unchanged)
- rag:eval ✓ (recall@5 ≥ 0.85 over 30 pairs)

If any job fails, fix and create a new commit (do not amend the tagged commit).

---

## Verification checklist (sub-projeto 13 exit criteria)

After Task 11 completes, all the following must be true:

1. ✅ Migration `0010` applied; `articles.theme` and `articles.summary` exist; CHECK constraint enforces taxonomy.
2. ✅ `lib/ingest/taxonomy.ts` exports `TAXONOMY`, `Theme`, `isValidTheme`, `THEME_DESCRIPTIONS` and is the single source of truth in TS-land.
3. ✅ `lib/ingest/classify-content.ts` calls OpenAI with structured-JSON mode, validates with zod, fails soft to filename-stem fallback. ~10 vitest tests covering all error paths.
4. ✅ `lib/ingest/pipeline.ts` orders dedup → classify → insert; new tests confirm `classifyContent` is NOT called on dedup hits.
5. ✅ `app/api/admin/articles/[id]/route.ts` PATCH handler with zod body validation; ~7 tests.
6. ✅ `<ThemeSidebar>` renders 12 buttons with counts; ~5 tests.
7. ✅ `/admin/articles` is a 3-col layout; theme filter + multi-select + bulk delete all work together.
8. ✅ `<ArticleDetail>` shows summary, dropdown of theme, pencil-edit on title; PATCHs persist.
9. ✅ `npm run articles:reclassify` re-classifies the corpus articles successfully; psycopg confirms titles + themes look reasonable.
10. ✅ `scripts/eval/golden.json` realigned with the new LLM-derived titles; `npm run rag:eval` passes with recall@5 ≥ 0.85.
11. ✅ `docs/product/beta-smoke-test.md` has 5 new manual smoke items.
12. ✅ CI green on `main` (typecheck + vitest + pytest + rag:eval).
13. ✅ `CLAUDE.md` updated with sub-projeto 13 row + structure update + gotchas.
14. ✅ Tag `auto-classified-library-complete` pushed to origin.
