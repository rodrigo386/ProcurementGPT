# Admin Chunks Visibility Implementation Plan (Sub-projeto 10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface every chunk extracted from each ingested article in `/admin/articles`, alongside a `≈% absorvido` indicator, with each chunk expandable to show its full content.

**Architecture:** A new `articles.source_chars` column (migration 0009, backfilled from `length(raw_md)` inline) is the denominator for the percent. The pipeline writes it on every new ingest. `<ArticleDetail>` renders the percent in the header and turns each chunk card into a native HTML `<details>` element so expand/collapse needs zero new dependencies.

**Tech Stack:** Next.js 14 (admin route is Node runtime), Supabase Postgres, TypeScript strict, vitest with jsdom for component tests.

**Spec:** `docs/superpowers/specs/2026-05-04-admin-chunks-visibility-design.md`

---

## File Structure

**New files:**
- `supabase/migrations/00000000000009_articles_source_chars.sql` — column + backfill + NOT NULL

**Modified files:**
- `lib/ingest/pipeline.ts` — `articles.insert` adds `source_chars: parsed.text.length`
- `tests/lib/ingest/pipeline.test.ts` — new assertion: inserted article carries `source_chars` matching `parsed.text` length
- `components/admin/ArticleDetail.tsx` — `AdminArticle` type gains `source_chars: number`; header line "N chunks · ≈X% absorvido"; chunks render as `<details>`; remove `.limit(20)`
- `tests/components/admin/ArticleDetail.test.tsx` — NEW file (none exists today): renders percent, native `<details>` collapsed by default, `source_chars=0` edge case, all chunks rendered (no limit)
- `components/admin/ArticlesSplitView.tsx` — `select(...)` includes `source_chars`
- `tests/components/admin/ArticlesSplitView.test.tsx` — chunks mock chain drops `.limit()` (now ends at `.order()`)
- `CLAUDE.md` — sub-projeto 10 row + 2 gotchas
- `docs/product/beta-readiness.md` — mark sub-projeto 10 as completo in the "Fila pós-beta" entry

---

## Conventions

- **Test runner:** `npm test` (vitest run). Single file: `npm test -- tests/components/admin/ArticleDetail.test.tsx`.
- **Component tests:** `// @vitest-environment jsdom` directive on line 1, `expect(...).toBeDefined()` instead of jest-dom matchers (no setup file registered).
- **Pipeline test pattern:** see `tests/lib/ingest/pipeline.test.ts` — inspects `insertedArticles[0]` payload directly.
- **DB client (browser):** `supabaseBrowser()` from `@/lib/db/supabase-browser`.
- **Migrations:** sequential 14-digit prefix; next is `00000000000009`.
- **Commits:** atomic per task. Format `<type>(<scope>): <subject>` with the standard `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` footer.
- **Branch:** `main` (project pattern).
- **Tag at end:** after Task 6 passes locally + CI, apply `admin-chunks-visibility-complete`.

---

## Task 1: Migration 0009 — `articles.source_chars` + backfill

**Files:**
- Create: `supabase/migrations/00000000000009_articles_source_chars.sql`

- [ ] **Step 1: Write the migration file**

Write to `supabase/migrations/00000000000009_articles_source_chars.sql`:

```sql
-- Sub-projeto 10: source_chars permite calcular % de absorção do texto na UI admin.
-- Backfill é trivial porque raw_md (NOT NULL desde a init) já guarda o texto parseado.

alter table articles add column source_chars int;

update articles set source_chars = length(raw_md) where source_chars is null;

alter table articles alter column source_chars set not null;
```

- [ ] **Step 2: Skip applying — manual via dashboard later**

Do NOT run `npm run db:migrate`. The user applies it as part of Task 6 prereqs (same as sub-projetos 8 + 9). Just create the file and commit.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00000000000009_articles_source_chars.sql
git commit -m "$(cat <<'EOF'
feat(db): add articles.source_chars + inline backfill (sub-projeto 10)

Backfill is a single UPDATE because raw_md is NOT NULL since the init
migration. After backfill the column is locked NOT NULL so future inserts
must populate it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Pipeline writes `source_chars` (TDD)

**Files:**
- Modify: `lib/ingest/pipeline.ts`
- Modify: `tests/lib/ingest/pipeline.test.ts`

- [ ] **Step 1: Add the failing assertion**

Open `tests/lib/ingest/pipeline.test.ts`. Locate the existing happy-path test (it asserts `insertedArticles).toHaveLength(1)`). Add a new `expect` immediately after that length assertion (or in a new dedicated `it` block; either is fine — the file already declares the same setup helpers):

```ts
    expect((m.insertedArticles[0] as Record<string, unknown>).source_chars).toBe(
      (m.insertedArticles[0] as Record<string, unknown>).raw_md
        ? ((m.insertedArticles[0] as Record<string, unknown>).raw_md as string).length
        : 0,
    );
```

If the file structure prefers a dedicated test, add this block at the end of the existing `describe(...)`:

```ts
  it('writes source_chars equal to the parsed text length on the new article row', async () => {
    const m = await runHappyPath();
    expect(m.insertedArticles).toHaveLength(1);
    const row = m.insertedArticles[0] as Record<string, unknown>;
    const rawMd = row.raw_md as string;
    expect(typeof row.source_chars).toBe('number');
    expect(row.source_chars).toBe(rawMd.length);
  });
```

(Use whichever style the existing file uses; the assertion content is the same.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/lib/ingest/pipeline.test.ts`
Expected: the new assertion FAILS — `source_chars` is `undefined` on the inserted payload.

- [ ] **Step 3: Update `lib/ingest/pipeline.ts`**

Locate the `.insert({ ... })` call on `articles` (currently around lines 60–69). Add a single line for `source_chars` so the insert payload becomes:

```ts
    const { data: article, error: insArtErr } = await sb
      .from('articles')
      .insert({
        title: meta.title,
        author: meta.author,
        language: meta.language,
        published_at: meta.date,
        source_chars: parsed.text.length,
        raw_md: parsed.text,
        metadata: { content_hash: hash, source_filename: job.filename },
      })
      .select('id')
      .single();
```

`source_chars` mirrors the parsed text length used for `raw_md`. Denormalized on purpose so we can move `raw_md` to Storage in the future without affecting consumers of `source_chars`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/lib/ingest/pipeline.test.ts`
Expected: all pipeline tests pass, including the new assertion.

- [ ] **Step 5: Run full vitest + typecheck**

Run: `npm test && npm run typecheck`
Expected: all 174+ tests pass; zero type errors.

- [ ] **Step 6: Commit**

```bash
git add lib/ingest/pipeline.ts tests/lib/ingest/pipeline.test.ts
git commit -m "$(cat <<'EOF'
feat(ingest): pipeline writes articles.source_chars on insert (sub-projeto 10)

Mirrors parsed.text.length (the same value persisted to raw_md) so the
admin UI can compute % absorvido from the chunks without depending on
raw_md staying in the row long-term.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `ArticlesSplitView` select gains `source_chars`

**Files:**
- Modify: `components/admin/ArticlesSplitView.tsx`
- Modify: `tests/components/admin/ArticlesSplitView.test.tsx`

- [ ] **Step 1: Update the component**

Open `components/admin/ArticlesSplitView.tsx`. Find the `.select(...)` call (currently `'id, title, author, language, published_at, ingested_at, metadata'`). Add `source_chars`:

```ts
      const { data } = await supabaseBrowser()
        .from('articles')
        .select('id, title, author, language, published_at, ingested_at, metadata, source_chars')
        .order('ingested_at', { ascending: false })
        .limit(100);
```

No other change in this file.

- [ ] **Step 2: Update the existing test fixture**

Open `tests/components/admin/ArticlesSplitView.test.tsx`. The `articles` array fixture (currently 2 rows) needs `source_chars` so the typecheck of `as ArticleRow[]` keeps passing once the type is extended in Task 4. Update both rows:

```ts
const articles = [
  {
    id: 'a1',
    title: 'Matriz de Kraljic na Prática Industrial',
    author: 'Silva, J.',
    language: 'pt',
    published_at: '2024-01-01',
    ingested_at: '2026-05-01T10:00:00Z',
    metadata: { content_hash: '3a7fb29c1234' },
    source_chars: 12000,
    chunks_count: 28,
  },
  {
    id: 'a2',
    title: 'The Strategic Sourcing Process Model',
    author: 'Monczka, R.',
    language: 'en',
    published_at: '2023-08-01',
    ingested_at: '2026-05-02T10:00:00Z',
    metadata: { content_hash: 'deadbeef' },
    source_chars: 18000,
    chunks_count: 42,
  },
];
```

- [ ] **Step 3: Run tests + typecheck**

Run: `npm test -- tests/components/admin/ArticlesSplitView.test.tsx && npm run typecheck`
Expected: 3/3 tests pass; zero type errors. (`source_chars` is unused in this file's logic right now, but the field is forward-compatible with Task 4.)

- [ ] **Step 4: Commit**

```bash
git add components/admin/ArticlesSplitView.tsx tests/components/admin/ArticlesSplitView.test.tsx
git commit -m "$(cat <<'EOF'
feat(admin/articles): include source_chars in articles select (sub-projeto 10)

Forward-compat for the % absorvido indicator that ArticleDetail will
render in the next commit. Test fixture extended.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `ArticleDetail` — % header + native `<details>` + no limit (TDD)

**Files:**
- Modify: `components/admin/ArticleDetail.tsx`
- Create: `tests/components/admin/ArticleDetail.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/components/admin/ArticleDetail.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fixtureChunks = [
  { id: 'c0', ord: 0, content: 'A'.repeat(3000) },
  { id: 'c1', ord: 1, content: 'B'.repeat(3000) },
  { id: 'c2', ord: 2, content: 'C'.repeat(2000) },
];

function mockSupabase(opts: { chunks?: typeof fixtureChunks } = {}) {
  vi.doMock('@/lib/db/supabase-browser', () => ({
    supabaseBrowser: () => ({
      from: (table: string) => {
        if (table === 'chunks') {
          return {
            select: () => ({
              eq: () => ({
                order: async () => ({ data: opts.chunks ?? fixtureChunks, error: null }),
              }),
            }),
          };
        }
        return { select: () => ({}) };
      },
    }),
  }));
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  cleanup();
});

const article = {
  id: 'a1',
  title: 'Matriz de Kraljic',
  author: 'Silva, J.',
  language: 'pt',
  published_at: '2024-01-01',
  metadata: { content_hash: '3a7fb29c1234' },
  ingested_at: '2026-05-01T10:00:00Z',
  source_chars: 7600,
};

describe('<ArticleDetail/>', () => {
  it('renders "N chunks · ≈X% absorvido" once chunks load', async () => {
    mockSupabase();
    const { ArticleDetail } = await import('@/components/admin/ArticleDetail');
    render(<ArticleDetail article={article} onDeleted={() => {}} />);

    // 3 chunks of 3000+3000+2000 = 8000 chars; source_chars 7600 => 105%.
    await waitFor(() =>
      expect(screen.getByText(/3 chunks · ≈105% absorvido/i)).toBeDefined(),
    );
  });

  it('renders one <details> per chunk, all collapsed by default', async () => {
    mockSupabase();
    const { ArticleDetail } = await import('@/components/admin/ArticleDetail');
    const { container } = render(<ArticleDetail article={article} onDeleted={() => {}} />);

    await waitFor(() => expect(container.querySelectorAll('details').length).toBe(3));
    container.querySelectorAll('details').forEach((d) => {
      expect((d as HTMLDetailsElement).open).toBe(false);
    });
  });

  it('expands the chunk content when the user clicks the summary', async () => {
    mockSupabase({
      chunks: [{ id: 'c0', ord: 0, content: 'CONTEÚDO_LONGO_DO_CHUNK'.repeat(50) }],
    });
    const { ArticleDetail } = await import('@/components/admin/ArticleDetail');
    const { container } = render(<ArticleDetail article={article} onDeleted={() => {}} />);

    const details = await waitFor(() => {
      const el = container.querySelector('details');
      expect(el).toBeTruthy();
      return el as HTMLDetailsElement;
    });
    expect(details.open).toBe(false);
    const summary = details.querySelector('summary')!;
    await userEvent.click(summary);
    expect(details.open).toBe(true);
  });

  it('shows "0%" instead of NaN when source_chars is 0', async () => {
    mockSupabase();
    const { ArticleDetail } = await import('@/components/admin/ArticleDetail');
    render(
      <ArticleDetail
        article={{ ...article, source_chars: 0 }}
        onDeleted={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/3 chunks · ≈0% absorvido/i)).toBeDefined(),
    );
  });

  it('renders all returned chunks (no client-side limit)', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `c${i}`,
      ord: i,
      content: `chunk ${i}`,
    }));
    mockSupabase({ chunks: many });
    const { ArticleDetail } = await import('@/components/admin/ArticleDetail');
    const { container } = render(<ArticleDetail article={article} onDeleted={() => {}} />);

    await waitFor(() => expect(container.querySelectorAll('details').length).toBe(50));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/components/admin/ArticleDetail.test.tsx`
Expected: at least the percent + `<details>` tests FAIL — current `ArticleDetail` doesn't render `≈X% absorvido` and uses `<div>` instead of `<details>`.

- [ ] **Step 3: Update `components/admin/ArticleDetail.tsx`**

Replace the file with:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { supabaseBrowser } from '@/lib/db/supabase-browser';
import { ConfirmDelete } from '@/components/admin/ConfirmDelete';

export type AdminArticle = {
  id: string;
  title: string;
  author: string | null;
  language: string;
  published_at: string | null;
  metadata: Record<string, unknown>;
  ingested_at: string;
  source_chars: number;
};

type Chunk = { id: string; ord: number; content: string };

type Props = {
  article: AdminArticle | null;
  onDeleted: (id: string) => void;
};

export function ArticleDetail({ article, onDeleted }: Props) {
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!article) {
      setChunks([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data } = await supabaseBrowser()
        .from('chunks')
        .select('id, ord, content')
        .eq('article_id', article.id)
        .order('ord', { ascending: true });
      if (cancelled) return;
      setChunks((data ?? []) as Chunk[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [article?.id]);

  if (!article) {
    return (
      <div className="text-sm text-muted-foreground p-4">
        Selecione um artigo na lista para inspecionar.
      </div>
    );
  }

  const hash = (article.metadata?.['content_hash'] as string | undefined) ?? '';
  const totalChunkChars = chunks.reduce((sum, c) => sum + c.content.length, 0);
  const absorvedPct =
    article.source_chars > 0
      ? Math.round((totalChunkChars / article.source_chars) * 100)
      : 0;

  async function handleDelete() {
    if (!article) return;
    const res = await fetch(`/api/admin/articles/${article.id}`, { method: 'DELETE' });
    if (res.ok) onDeleted(article.id);
  }

  return (
    <div className="p-4 space-y-3 overflow-y-auto h-full">
      <div>
        <h3 className="text-sm font-semibold">{article.title}</h3>
        <p className="text-xs text-muted-foreground">
          {[article.author, article.language?.toUpperCase(), article.published_at, hash ? `SHA: ${hash.slice(0, 8)}…` : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {chunks.length} chunks · ≈{absorvedPct}% absorvido
        </p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" onClick={() => setConfirmOpen(true)}>
          Excluir
        </Button>
      </div>
      <div className="space-y-1">
        {loading && <p className="text-xs text-muted-foreground">Carregando chunks…</p>}
        {!loading && chunks.length === 0 && (
          <p className="text-xs text-muted-foreground">Nenhum chunk disponível.</p>
        )}
        {chunks.map((c) => (
          <details
            key={c.id}
            className="bg-muted/40 rounded-md border-l-2 border-border text-xs leading-relaxed"
          >
            <summary className="cursor-pointer p-2 hover:bg-muted/60">
              <span className="text-muted-foreground mr-2 tabular-nums">#{c.ord}</span>
              {c.content.slice(0, 200)}
              {c.content.length > 200 && '…'}
            </summary>
            <pre className="mt-2 px-3 pb-3 whitespace-pre-wrap font-mono text-[11px]">
              {c.content}
            </pre>
          </details>
        ))}
      </div>
      <ConfirmDelete
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Excluir artigo"
        description={`Esta ação remove "${article.title}" e todos os chunks associados. Não pode ser desfeita.`}
        onConfirm={handleDelete}
      />
    </div>
  );
}
```

Key changes vs. previous:
- `AdminArticle` type adds `source_chars: number`.
- New `<p>` line in the header showing chunks + percent.
- `.limit(20)` removed from chunks query.
- Chunks render as `<details>` with `<summary>` (preview) and `<pre>` (full content), instead of plain `<div>`.

- [ ] **Step 4: Update the existing `ArticlesSplitView.test.tsx` chunks mock chain**

The chunks mock chain in `tests/components/admin/ArticlesSplitView.test.tsx` currently ends at `.limit(...)`. The component now ends at `.order(...)`. Update the chunks branch of the mock:

```ts
        if (table === 'chunks') {
          return {
            select: () => ({
              eq: () => ({
                order: async () => ({
                  data: [{ id: 'c1', ord: 0, content: 'A matriz de Kraljic propõe…' }],
                  error: null,
                }),
              }),
            }),
          };
        }
```

(Drop the `.limit(...)` step; `order` now resolves the data directly.)

- [ ] **Step 5: Run all tests + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests pass (target: ~179: previous 174 + 5 new ArticleDetail tests), zero type errors, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add components/admin/ArticleDetail.tsx tests/components/admin/ArticleDetail.test.tsx tests/components/admin/ArticlesSplitView.test.tsx
git commit -m "$(cat <<'EOF'
feat(admin/articles): show ≈% absorvido + native <details> per chunk (sub-projeto 10)

ArticleDetail header gains "N chunks · ≈X% absorvido". The percent is
the sum of chunk content lengths divided by article.source_chars (so it
can exceed 100% on small articles thanks to the 400-char overlap — the
≈ prefix flags the approximation). Chunks render as <details>/<summary>
so expand/collapse needs zero new deps and inherits browser a11y.
.limit(20) removed; all chunks now render. ArticlesSplitView chunks
mock chain updated to drop the now-absent .limit step.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: CLAUDE.md + beta-readiness updates

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/product/beta-readiness.md`

- [ ] **Step 1: Add the sub-projeto 10 row in CLAUDE.md**

Find the row for sub-projeto 9 in `## Status — sub-projetos completos`. Add IMMEDIATELY after it:

```markdown
| 10 | `admin-chunks-visibility-complete` | `/admin/articles` detail pane lista TODOS os chunks por artigo (sem `limit(20)`) e mostra "N chunks · ≈X% absorvido" no header. % = `sum(chunk.content.length) / source_chars`; pode exceder 100% por causa do overlap de 400 chars (prefix `≈` deixa explícito). Migration 0009 adiciona `articles.source_chars int NOT NULL` com backfill inline (`length(raw_md)`). Pipeline grava `source_chars: parsed.text.length` no insert do artigo. Chunks renderizam como `<details>` HTML nativo (sem dep nova; expand/collapse com a11y de browser). |
```

- [ ] **Step 2: Add gotchas to "O que evitar"**

Append to the end of the existing list:

```
- Calcular % absorvido sem o prefix `≈` na UI — o valor é overcount intencional pelo overlap (400 chars) e pode passar de 100% em artigos pequenos. O prefix é a comunicação visual de aproximação.
- Mover `raw_md` do row do `articles` sem antes garantir que `source_chars` continua sendo populado — sub-projeto 10 deliberadamente denormaliza para que essa migração futura não quebre a UI admin.
```

- [ ] **Step 3: Update `docs/product/beta-readiness.md`**

Find the "Sub-projeto 10 — Visibilidade da ingestão" entry under "Fila pós-beta". Add a "Status" line at the top of that subsection:

```markdown
**Status**: ✅ completo (`admin-chunks-visibility-complete`), 2026-05-04.
```

Place it right after the heading (before the "**Capturado em**" line) so the entry stays self-contained.

- [ ] **Step 4: Sanity tests**

Run: `npm test && npm run typecheck`
Expected: zero failures, zero type errors. Docs don't affect builds, but running anyway proves no other file was touched.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/product/beta-readiness.md
git commit -m "$(cat <<'EOF'
docs(CLAUDE.md): record sub-projeto 10 + 2 gotchas; mark backlog item done

Status row references admin-chunks-visibility-complete. Gotchas cover
the ≈ prefix on the percent (overlap overcount is intentional) and the
denormalization of source_chars vs. raw_md. beta-readiness.md "Fila
pós-beta" entry marked completo.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Final verification + push + tag

**Files:**
- None modified.

- [ ] **Step 1: Local full test matrix**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests pass (~179), zero type errors, build succeeds.

- [ ] **Step 2: Run the eval gate**

Run: `npm run rag:eval`
Expected: `recall@5 ≥ 0.85`. Sub-projeto 10 doesn't touch retrieval, so no movement expected.

- [ ] **Step 3: Apply migration 0009 to production Supabase (manual)**

Either run `npm run db:migrate` if the CLI is linked, or paste the migration into the Supabase SQL editor. Verify:

```sql
select count(*) from articles where source_chars is null;
-- expected: 0
select source_chars, length(raw_md) from articles limit 5;
-- expected: source_chars equals length(raw_md) on every row
```

- [ ] **Step 4: Push commits**

```bash
git push origin main
```

Expected: CI runs typecheck + vitest + `next build` (added in sub-projeto 9 fix) + pytest + rag:eval. Wait for green.

- [ ] **Step 5: Apply the milestone tag**

```bash
git tag admin-chunks-visibility-complete
git push origin admin-chunks-visibility-complete
```

- [ ] **Step 6: Smoke check on Railway**

After CI green and Railway redeploys:
1. Open `https://procurementgpt-production.up.railway.app/admin/articles`.
2. Click any article in the list.
3. Verify the header shows "N chunks · ≈X% absorvido" with sensible numbers.
4. Click any chunk — `<details>` expands, full chunk content visible in monospace.
5. Verify list shows ALL chunks (no truncation at 20).
6. Try a freshly-ingested PDF — `source_chars` should be populated automatically.

If any step fails, file an issue and fix before closing this sub-projeto.

---

## Self-Review (post-write)

**Spec coverage:**
- §1 Modelo de dados / Migration 0009 → Task 1
- §2 Pipeline writes source_chars → Task 2
- §3 ArticleDetail UI (% header + `<details>` + remove limit + type) → Task 4
- §4 ArticlesSplitView select → Task 3
- §5 CLAUDE.md → Task 5
- §6 Não-objetivos → not implemented (deliberate)
- Critério de "pronto" → Task 6 + Task 5 (beta-readiness mark)
- Riscos / decisões deferidas → Task 5 gotchas

**Placeholder scan:** no TBDs; every code block is complete and runnable. The "use whichever style the existing file uses" line in Task 2 step 1 is acceptable because both alternatives are spelled out fully.

**Type consistency:**
- `AdminArticle` adds `source_chars: number` consistently (Task 3 fixture, Task 4 type, Task 4 test data).
- `Chunk` type unchanged (`{ id; ord; content }`).
- Mock chain shape (`select → eq → order` resolving to `{ data, error }`) consistent in both ArticleDetail.test.tsx (new) and ArticlesSplitView.test.tsx (updated to drop `.limit`).
- `source_chars` snake_case at DB + payload + select; camelCase nowhere (single-tier naming).
- Percent calculation formula identical in component code and test fixture: `Math.round((sum(c.content.length) / source_chars) * 100)`.

No fixes needed inline.

---

## Open Questions / Deferred

- If a beta tester ingests a 500-page document and the unbounded chunks render slows down the page, paginate at the source — split into a dedicated sub-projeto with virtualization. For now ~30 chunks/article is fine.
- If `raw_md` ever moves to Storage, `source_chars` stays as the only source of truth for the percent — confirmed by the gotcha in Task 5.
