# Retrieval (RAG) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `lib/rag/` (5 modules + types) plus one Postgres RPC migration, a CLI (`npm run rag:query`) and an offline eval harness (`npm run rag:eval`), so that `runRag(query)` produces a typed `{ classification, sources, system, user }` ready to feed the chat endpoint in sub-projeto 4.

**Architecture:** `runRag` orchestrates classify → (if needed) retrieve (vector + FTS, RRF fused) → rerank → buildPrompt. Everything is Edge-Runtime-compatible (Supabase JS RPC + the existing `lib/llm/*` HTTP wrappers; no Node-only deps). RPCs are `security definer` because RLS has no policies yet (sub-projeto 6 hardens). The classifier never blocks — failure returns a safe default.

**Tech Stack:** TypeScript strict, `@supabase/supabase-js`, `@google/genai`, `zod` (new), `tsx` (new, devDependency), `vitest`.

**Spec:** `docs/superpowers/specs/2026-05-02-retrieval-design.md`

---

## File Structure & Responsibility Map

| File | Responsibility |
|------|---------------|
| `lib/rag/types.ts` | Shared types: `Classification`, `RetrievedChunk`, `SourceRef`, `RagResult`, `Intent` |
| `lib/rag/classifier.ts` | Single Gemini Flash call → typed `Classification`; safe default on any failure |
| `lib/rag/retriever.ts` | Embeds query (Voyage), parallel RPC calls (vector + FTS), RRF fusion, joins article titles |
| `lib/rag/reranker.ts` | Wraps `lib/llm/cohere.ts:rerank()`; maps hit indices back to chunks; falls back to RRF order on failure |
| `lib/rag/prompt-builder.ts` | Pure function: builds system + user prompts with numbered citation tokens; handles empty-context branch |
| `lib/rag/index.ts` | `runRag(query)` orchestrator with timing |
| `lib/llm/voyage.ts` | **MODIFY** — add optional `inputType?: 'query'\|'document'` param |
| `tests/lib/rag/*.test.ts` | Unit tests for the five rag modules (mocks at HTTP/RPC boundary) |
| `tests/lib/voyage.test.ts` | **MODIFY** — add a test for the `inputType` param |
| `supabase/migrations/00000000000002_rag_rpc.sql` | `match_chunks()` + `search_chunks_fts()` SQL functions |
| `scripts/rag-query.ts` | CLI for ad-hoc retrieval debugging |
| `scripts/eval/run.ts` | Eval harness: runs golden set through `runRag`, prints recall@5/MRR/latency |
| `scripts/eval/golden.json` | 10 PT-BR Q&A pairs with `expected_titles` |
| `package.json` | **MODIFY** — add `zod`, `tsx`; add `rag:query` and `rag:eval` scripts |

---

## Task 1: Add `zod` and `tsx` dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install `zod` (runtime) and `tsx` (devDependency)**

Run:

```bash
npm install zod@^3.23.8
npm install -D tsx@^4.19.0
```

Expected: `zod` lands in `dependencies`, `tsx` in `devDependencies`. `package-lock.json` updated.

- [ ] **Step 2: Verify install**

Run:

```bash
node -e "console.log(require('zod').z.string().parse('ok'))"
npx tsx --version
```

Expected: prints `ok`, then prints a tsx version like `tsx v4.x.x`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(rag): add zod and tsx for sub-projeto 3"
```

---

## Task 2: Migration — `match_chunks` and `search_chunks_fts` RPCs

**Files:**
- Create: `supabase/migrations/00000000000002_rag_rpc.sql`

- [ ] **Step 1: Create the migration file**

Write `supabase/migrations/00000000000002_rag_rpc.sql`:

```sql
-- RAG retrieval RPC functions (sub-projeto 3).
-- security definer because RLS is enabled on chunks/articles but has no policies
-- (Fundação decision). Sub-projeto 6 (Auth) revisits.

create or replace function match_chunks(
  query_embedding vector(1024),
  match_count int default 20
)
returns table (
  chunk_id uuid,
  article_id uuid,
  content text,
  ord int,
  similarity float
)
language sql
security definer
set search_path = public
as $$
  select c.id, c.article_id, c.content, c.ord,
         1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function search_chunks_fts(
  query_text text,
  match_count int default 20
)
returns table (
  chunk_id uuid,
  article_id uuid,
  content text,
  ord int,
  rank float
)
language sql
security definer
set search_path = public
as $$
  select c.id, c.article_id, c.content, c.ord,
         ts_rank(c.tsv, websearch_to_tsquery('portuguese', query_text)) as rank
  from chunks c
  where c.tsv @@ websearch_to_tsquery('portuguese', query_text)
  order by rank desc
  limit match_count;
$$;

grant execute on function match_chunks(vector, int) to anon, authenticated, service_role;
grant execute on function search_chunks_fts(text, int) to anon, authenticated, service_role;
```

- [ ] **Step 2: Apply the migration**

Apply via Supabase Dashboard SQL Editor (paste the SQL and Run) for project `ohfgrcnouudzshnpziiw`. Or via CLI if `supabase db push` is linked.

Expected: `CREATE FUNCTION` × 2, `GRANT` × 2. No errors.

- [ ] **Step 3: Verify functions exist and are callable with the anon key**

In SQL editor (or via psycopg), run:

```sql
select proname, pg_get_function_identity_arguments(oid) as args
from pg_proc
where proname in ('match_chunks', 'search_chunks_fts');
```

Expected: 2 rows.

Then smoke-test the FTS function (works without an embedding):

```sql
select chunk_id, ord, rank
from search_chunks_fts('Kraljic', 3);
```

Expected: zero or more rows; no error. (Empty if no Kraljic chunks; if you ran the Task 11 smoke from sub-projeto 2, you should see ≥ 1 row.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00000000000002_rag_rpc.sql
git commit -m "feat(rag): add match_chunks and search_chunks_fts RPCs"
```

---

## Task 3: `lib/rag/types.ts`

**Files:**
- Create: `lib/rag/types.ts`

- [ ] **Step 1: Write the types module**

Write `lib/rag/types.ts`:

```ts
export type Intent =
  | 'definition'
  | 'application'
  | 'comparison'
  | 'recommendation'
  | 'smalltalk';

export type Classification = {
  theory: string | null;
  intent: Intent;
  language: 'pt' | 'en';
  needsRetrieval: boolean;
};

export type RetrievedChunk = {
  chunkId: string;
  articleId: string;
  content: string;
  ord: number;
  articleTitle: string;
  vectorRank: number | null;
  ftsRank: number | null;
  rrfScore: number;
  rerankScore: number | null;
};

export type SourceRef = {
  number: number;
  articleId: string;
  articleTitle: string;
  chunkId: string;
};

export type RagDebug = {
  classifyMs: number;
  embedMs: number;
  vectorMs: number;
  ftsMs: number;
  rerankMs: number;
  totalMs: number;
};

export type RagResult = {
  classification: Classification;
  sources: SourceRef[];
  system: string;
  user: string;
  debug: RagDebug;
};

export const SAFE_DEFAULT_CLASSIFICATION: Classification = {
  theory: null,
  intent: 'definition',
  language: 'pt',
  needsRetrieval: true,
};
```

- [ ] **Step 2: Verify it type-checks**

Run:

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add lib/rag/types.ts
git commit -m "feat(rag): add shared types for retrieval pipeline"
```

---

## Task 4: Extend `lib/llm/voyage.ts` with optional `inputType`

**Files:**
- Modify: `lib/llm/voyage.ts`
- Modify: `tests/lib/voyage.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/voyage.test.ts` (inside the existing `describe('voyage embed', ...)` block, before the closing `});`):

```ts
  it('forwards inputType to Voyage when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.5] }] }), { status: 200 }),
    );
    globalThis.fetch = mockFetch as typeof fetch;

    const { embed } = await import('@/lib/llm/voyage');
    await embed(['q'], 'query');

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ model: 'voyage-3-large', input: ['q'], input_type: 'query' });
  });

  it('omits input_type when inputType is not provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.5] }] }), { status: 200 }),
    );
    globalThis.fetch = mockFetch as typeof fetch;

    const { embed } = await import('@/lib/llm/voyage');
    await embed(['q']);

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).not.toHaveProperty('input_type');
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run:

```bash
npx vitest run tests/lib/voyage.test.ts
```

Expected: the existing 3 tests still pass; the 2 new tests fail (function signature does not yet accept a second arg, or body lacks `input_type`).

- [ ] **Step 3: Update `lib/llm/voyage.ts`**

Replace the contents of `lib/llm/voyage.ts` with:

```ts
import { requireEnv } from '@/lib/env';

const ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const TIMEOUT_MS = 30_000;

export type VoyageInputType = 'query' | 'document';

export async function embed(
  texts: string[],
  inputType?: VoyageInputType,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const apiKey = requireEnv('VOYAGE_API_KEY');
  const model = requireEnv('VOYAGE_MODEL');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const body: Record<string, unknown> = { model, input: texts };
  if (inputType) body.input_type = inputType;

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Voyage embed failed (${res.status}): ${detail}`);
    }

    const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return json.data.map((d) => d.embedding);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run all voyage tests**

Run:

```bash
npx vitest run tests/lib/voyage.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run:

```bash
npm test
```

Expected: 17 passed (was 15; the 2 new voyage tests added).

- [ ] **Step 6: Commit**

```bash
git add lib/llm/voyage.ts tests/lib/voyage.test.ts
git commit -m "feat(llm): voyage embed accepts optional inputType (query|document)"
```

---

## Task 5: `lib/rag/classifier.ts` (TDD)

**Files:**
- Create: `lib/rag/classifier.ts`
- Create: `tests/lib/rag/classifier.test.ts`

- [ ] **Step 1: Write the failing tests**

Write `tests/lib/rag/classifier.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi } from 'vitest';

beforeEach(() => {
  process.env.GOOGLE_API_KEY = 'test-key';
  process.env.GEMINI_MODEL = 'gemini-test';
  vi.resetModules();
});

function mockGemini(returns: { text?: string; throws?: Error }) {
  vi.doMock('@/lib/llm/gemini', () => ({
    getGemini: () => ({
      models: {
        generateContent: vi.fn().mockImplementation(async () => {
          if (returns.throws) throw returns.throws;
          return { text: returns.text ?? '' };
        }),
      },
    }),
  }));
}

describe('rag classifier', () => {
  it('returns parsed classification on valid JSON', async () => {
    mockGemini({
      text: JSON.stringify({
        theory: 'kraljic',
        intent: 'definition',
        language: 'pt',
        needsRetrieval: true,
      }),
    });
    const { classify } = await import('@/lib/rag/classifier');
    const result = await classify('o que é a matriz de Kraljic?');
    expect(result).toEqual({
      theory: 'kraljic',
      intent: 'definition',
      language: 'pt',
      needsRetrieval: true,
    });
  });

  it('returns safe default when Gemini throws', async () => {
    mockGemini({ throws: new Error('boom') });
    const { classify } = await import('@/lib/rag/classifier');
    const result = await classify('hello');
    expect(result).toEqual({
      theory: null,
      intent: 'definition',
      language: 'pt',
      needsRetrieval: true,
    });
  });

  it('returns safe default when JSON is malformed', async () => {
    mockGemini({ text: 'not json {' });
    const { classify } = await import('@/lib/rag/classifier');
    const result = await classify('hi');
    expect(result.intent).toBe('definition');
    expect(result.needsRetrieval).toBe(true);
    expect(result.theory).toBeNull();
  });

  it('returns safe default when intent enum is invalid', async () => {
    mockGemini({
      text: JSON.stringify({
        theory: null,
        intent: 'bogus',
        language: 'pt',
        needsRetrieval: true,
      }),
    });
    const { classify } = await import('@/lib/rag/classifier');
    const result = await classify('?');
    expect(result.intent).toBe('definition');
  });

  it('accepts smalltalk intent and propagates needsRetrieval=false', async () => {
    mockGemini({
      text: JSON.stringify({
        theory: null,
        intent: 'smalltalk',
        language: 'pt',
        needsRetrieval: false,
      }),
    });
    const { classify } = await import('@/lib/rag/classifier');
    const result = await classify('oi');
    expect(result.intent).toBe('smalltalk');
    expect(result.needsRetrieval).toBe(false);
  });

  it('accepts theory as null and intent as application', async () => {
    mockGemini({
      text: JSON.stringify({
        theory: null,
        intent: 'application',
        language: 'en',
        needsRetrieval: true,
      }),
    });
    const { classify } = await import('@/lib/rag/classifier');
    const result = await classify('how to apply Kraljic in food retail?');
    expect(result.intent).toBe('application');
    expect(result.language).toBe('en');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run tests/lib/rag/classifier.test.ts
```

Expected: import error or all 6 tests failing — module does not exist yet.

- [ ] **Step 3: Implement `lib/rag/classifier.ts`**

Write `lib/rag/classifier.ts`:

```ts
import { z } from 'zod';
import { getGemini } from '@/lib/llm/gemini';
import { requireEnv } from '@/lib/env';
import { SAFE_DEFAULT_CLASSIFICATION, type Classification } from './types';

const SYSTEM_PROMPT = `Você classifica perguntas de usuários sobre teorias de procurement (compras corporativas).
Responda SEMPRE com JSON estrito conforme o schema abaixo. Não adicione texto fora do JSON.

Campos:
- theory: string com o nome curto da teoria/framework principal mencionada (ex: "kraljic", "porter", "monczka", "tco", "srm"). null se nenhuma teoria específica for citada ou inferível.
- intent: um de "definition" | "application" | "comparison" | "recommendation" | "smalltalk".
  - definition: pede o que é, conceito, definição
  - application: pede como aplicar, exemplo prático, caso
  - comparison: compara duas ou mais teorias/frameworks
  - recommendation: pede sugestão de abordagem/teoria/leitura
  - smalltalk: saudação, agradecimento, pergunta sobre o próprio bot, sem conteúdo de procurement
- language: "pt" se a pergunta está em português, "en" se em inglês. Default "pt".
- needsRetrieval: false APENAS se intent = "smalltalk". Senão true.`;

const ClassificationSchema = z.object({
  theory: z.string().nullable(),
  intent: z.enum(['definition', 'application', 'comparison', 'recommendation', 'smalltalk']),
  language: z.enum(['pt', 'en']),
  needsRetrieval: z.boolean(),
});

export async function classify(query: string): Promise<Classification> {
  try {
    const ai = getGemini();
    const model = requireEnv('GEMINI_MODEL');
    const res = await ai.models.generateContent({
      model,
      contents: `${SYSTEM_PROMPT}\n\nPergunta:\n${query}`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            theory: { type: 'string', nullable: true },
            intent: {
              type: 'string',
              enum: ['definition', 'application', 'comparison', 'recommendation', 'smalltalk'],
            },
            language: { type: 'string', enum: ['pt', 'en'] },
            needsRetrieval: { type: 'boolean' },
          },
          required: ['theory', 'intent', 'language', 'needsRetrieval'],
        },
        maxOutputTokens: 256,
      },
    });
    const text = res.text ?? '';
    const parsed = ClassificationSchema.parse(JSON.parse(text));
    return parsed;
  } catch (err) {
    console.warn('[rag/classifier] falling back to safe default:', err);
    return { ...SAFE_DEFAULT_CLASSIFICATION };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run tests/lib/rag/classifier.test.ts
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/rag/classifier.ts tests/lib/rag/classifier.test.ts
git commit -m "feat(rag): add classifier with safe-default fallback"
```

---

## Task 6: `lib/rag/retriever.ts` (TDD on RRF)

**Files:**
- Create: `lib/rag/retriever.ts`
- Create: `tests/lib/rag/retriever.test.ts`

- [ ] **Step 1: Write the failing tests**

Write `tests/lib/rag/retriever.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi } from 'vitest';

beforeEach(() => {
  process.env.VOYAGE_API_KEY = 'test-key';
  process.env.VOYAGE_MODEL = 'voyage-3-large';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  vi.resetModules();
});

type RpcResult = { data: unknown; error: null | { message: string } };

function mockSupabase(handlers: {
  matchChunks?: () => Promise<RpcResult>;
  searchChunksFts?: () => Promise<RpcResult>;
  articlesIn?: (ids: string[]) => Promise<RpcResult>;
}) {
  vi.doMock('@/lib/db/supabase', () => ({
    getServerSupabase: () => ({
      rpc: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'match_chunks') {
          return handlers.matchChunks ? handlers.matchChunks() : { data: [], error: null };
        }
        if (name === 'search_chunks_fts') {
          return handlers.searchChunksFts
            ? handlers.searchChunksFts()
            : { data: [], error: null };
        }
        return { data: [], error: null };
      }),
      from: vi.fn().mockImplementation(() => ({
        select: () => ({
          in: (_col: string, ids: string[]) =>
            handlers.articlesIn
              ? handlers.articlesIn(ids)
              : Promise.resolve({ data: [], error: null }),
        }),
      })),
    }),
  }));
}

function mockEmbed() {
  vi.doMock('@/lib/llm/voyage', () => ({
    embed: vi.fn().mockResolvedValue([new Array(1024).fill(0.01)]),
  }));
}

describe('rag retriever', () => {
  it('returns empty when both vector and FTS are empty', async () => {
    mockEmbed();
    mockSupabase({});
    const { retrieve } = await import('@/lib/rag/retriever');
    const result = await retrieve('anything');
    expect(result).toEqual([]);
  });

  it('orders chunks by RRF score across both lists with dedup', async () => {
    mockEmbed();
    mockSupabase({
      matchChunks: async () => ({
        data: [
          { chunk_id: 'A', article_id: 'art1', content: 'a', ord: 0, similarity: 0.9 },
          { chunk_id: 'B', article_id: 'art1', content: 'b', ord: 1, similarity: 0.8 },
          { chunk_id: 'C', article_id: 'art2', content: 'c', ord: 0, similarity: 0.7 },
        ],
        error: null,
      }),
      searchChunksFts: async () => ({
        data: [
          { chunk_id: 'C', article_id: 'art2', content: 'c', ord: 0, rank: 0.5 },
          { chunk_id: 'A', article_id: 'art1', content: 'a', ord: 0, rank: 0.4 },
          { chunk_id: 'D', article_id: 'art3', content: 'd', ord: 0, rank: 0.3 },
        ],
        error: null,
      }),
      articlesIn: async (ids) => ({
        data: ids.map((id) => ({ id, title: `Title-${id}` })),
        error: null,
      }),
    });

    const { retrieve } = await import('@/lib/rag/retriever');
    const result = await retrieve('q', { rrfK: 60 });

    // Each unique chunkId appears once
    const ids = result.map((r) => r.chunkId);
    expect(new Set(ids).size).toBe(ids.length);

    // A and C appear in both → highest scores. A ranks #1 in vector + #2 in fts. C ranks #3 in vector + #1 in fts.
    // RRF(A) = 1/61 + 1/62 ; RRF(C) = 1/63 + 1/61. A > C.
    expect(result[0]?.chunkId).toBe('A');
    expect(result[1]?.chunkId).toBe('C');
    // B (vector only, rank 2) vs D (fts only, rank 3): B should outrank D.
    const bIdx = ids.indexOf('B');
    const dIdx = ids.indexOf('D');
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(dIdx).toBeGreaterThan(bIdx);

    // Joins article titles
    expect(result[0]?.articleTitle).toBe('Title-art1');
  });

  it('preserves vector order when FTS is empty', async () => {
    mockEmbed();
    mockSupabase({
      matchChunks: async () => ({
        data: [
          { chunk_id: 'X', article_id: 'a', content: 'x', ord: 0, similarity: 0.9 },
          { chunk_id: 'Y', article_id: 'a', content: 'y', ord: 1, similarity: 0.8 },
        ],
        error: null,
      }),
      articlesIn: async (ids) => ({
        data: ids.map((id) => ({ id, title: 't' })),
        error: null,
      }),
    });

    const { retrieve } = await import('@/lib/rag/retriever');
    const result = await retrieve('q');
    expect(result.map((r) => r.chunkId)).toEqual(['X', 'Y']);
    expect(result[0]?.vectorRank).toBe(1);
    expect(result[0]?.ftsRank).toBeNull();
  });

  it('truncates result to outK', async () => {
    mockEmbed();
    const many = Array.from({ length: 50 }, (_, i) => ({
      chunk_id: `c${i}`,
      article_id: 'a',
      content: 'x',
      ord: i,
      similarity: 1 - i * 0.01,
    }));
    mockSupabase({
      matchChunks: async () => ({ data: many, error: null }),
      articlesIn: async (ids) => ({
        data: ids.map((id) => ({ id, title: 't' })),
        error: null,
      }),
    });

    const { retrieve } = await import('@/lib/rag/retriever');
    const result = await retrieve('q', { outK: 5 });
    expect(result).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run tests/lib/rag/retriever.test.ts
```

Expected: import errors — module not yet defined.

- [ ] **Step 3: Implement `lib/rag/retriever.ts`**

Write `lib/rag/retriever.ts`:

```ts
import { getServerSupabase } from '@/lib/db/supabase';
import { embed } from '@/lib/llm/voyage';
import type { RetrievedChunk } from './types';

export type RetrieveOptions = {
  vectorK?: number;
  ftsK?: number;
  rrfK?: number;
  outK?: number;
};

const DEFAULTS = { vectorK: 20, ftsK: 20, rrfK: 60, outK: 30 } as const;

type VectorRow = {
  chunk_id: string;
  article_id: string;
  content: string;
  ord: number;
  similarity: number;
};
type FtsRow = {
  chunk_id: string;
  article_id: string;
  content: string;
  ord: number;
  rank: number;
};

export async function retrieve(
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  const { vectorK, ftsK, rrfK, outK } = { ...DEFAULTS, ...opts };
  const supabase = getServerSupabase();

  const [embedding] = await embed([query], 'query');
  if (!embedding) return [];

  const [vecRes, ftsRes] = await Promise.all([
    supabase.rpc('match_chunks', {
      query_embedding: embedding,
      match_count: vectorK,
    }),
    supabase.rpc('search_chunks_fts', {
      query_text: query,
      match_count: ftsK,
    }),
  ]);

  const vecRows = (vecRes.error ? [] : (vecRes.data as VectorRow[])) ?? [];
  const ftsRows = (ftsRes.error ? [] : (ftsRes.data as FtsRow[])) ?? [];

  if (vecRes.error) console.warn('[rag/retriever] match_chunks error:', vecRes.error);
  if (ftsRes.error) console.warn('[rag/retriever] search_chunks_fts error:', ftsRes.error);

  if (vecRows.length === 0 && ftsRows.length === 0) return [];

  const fused = new Map<
    string,
    {
      chunkId: string;
      articleId: string;
      content: string;
      ord: number;
      vectorRank: number | null;
      ftsRank: number | null;
      rrfScore: number;
    }
  >();

  vecRows.forEach((row, i) => {
    const rank = i + 1;
    const score = 1 / (rrfK + rank);
    fused.set(row.chunk_id, {
      chunkId: row.chunk_id,
      articleId: row.article_id,
      content: row.content,
      ord: row.ord,
      vectorRank: rank,
      ftsRank: null,
      rrfScore: score,
    });
  });

  ftsRows.forEach((row, i) => {
    const rank = i + 1;
    const score = 1 / (rrfK + rank);
    const existing = fused.get(row.chunk_id);
    if (existing) {
      existing.ftsRank = rank;
      existing.rrfScore += score;
    } else {
      fused.set(row.chunk_id, {
        chunkId: row.chunk_id,
        articleId: row.article_id,
        content: row.content,
        ord: row.ord,
        vectorRank: null,
        ftsRank: rank,
        rrfScore: score,
      });
    }
  });

  const ranked = [...fused.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, outK);

  if (ranked.length === 0) return [];

  const articleIds = [...new Set(ranked.map((r) => r.articleId))];
  const { data: articles, error: articlesErr } = await supabase
    .from('articles')
    .select('id,title')
    .in('id', articleIds);

  if (articlesErr) console.warn('[rag/retriever] articles join error:', articlesErr);

  const titleById = new Map<string, string>();
  for (const a of (articles as { id: string; title: string }[] | null) ?? []) {
    titleById.set(a.id, a.title);
  }

  return ranked.map((r) => ({
    chunkId: r.chunkId,
    articleId: r.articleId,
    content: r.content,
    ord: r.ord,
    articleTitle: titleById.get(r.articleId) ?? '(unknown)',
    vectorRank: r.vectorRank,
    ftsRank: r.ftsRank,
    rrfScore: r.rrfScore,
    rerankScore: null,
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run tests/lib/rag/retriever.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/rag/retriever.ts tests/lib/rag/retriever.test.ts
git commit -m "feat(rag): add hybrid retriever with RRF fusion"
```

---

## Task 7: `lib/rag/reranker.ts` (TDD)

**Files:**
- Create: `lib/rag/reranker.ts`
- Create: `tests/lib/rag/reranker.test.ts`

- [ ] **Step 1: Write the failing tests**

Write `tests/lib/rag/reranker.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { RetrievedChunk } from '@/lib/rag/types';

beforeEach(() => {
  process.env.COHERE_API_KEY = 'test-key';
  process.env.COHERE_RERANK_MODEL = 'rerank-multilingual-v3.0';
  vi.resetModules();
});

function chunk(id: string, content: string, rrfScore: number): RetrievedChunk {
  return {
    chunkId: id,
    articleId: `art-${id}`,
    content,
    ord: 0,
    articleTitle: `Title ${id}`,
    vectorRank: null,
    ftsRank: null,
    rrfScore,
    rerankScore: null,
  };
}

describe('rag reranker', () => {
  it('returns empty without calling Cohere when input is empty', async () => {
    const cohereSpy = vi.fn();
    vi.doMock('@/lib/llm/cohere', () => ({ rerank: cohereSpy }));
    const { rerank } = await import('@/lib/rag/reranker');
    const out = await rerank('q', [], 5);
    expect(out).toEqual([]);
    expect(cohereSpy).not.toHaveBeenCalled();
  });

  it('reorders chunks by Cohere index and annotates rerankScore', async () => {
    vi.doMock('@/lib/llm/cohere', () => ({
      rerank: vi.fn().mockResolvedValue([
        { index: 2, relevanceScore: 0.95 },
        { index: 0, relevanceScore: 0.7 },
      ]),
    }));
    const input = [chunk('A', 'a', 0.5), chunk('B', 'b', 0.4), chunk('C', 'c', 0.3)];
    const { rerank } = await import('@/lib/rag/reranker');
    const out = await rerank('q', input, 2);
    expect(out.map((c) => c.chunkId)).toEqual(['C', 'A']);
    expect(out[0]?.rerankScore).toBe(0.95);
    expect(out[1]?.rerankScore).toBe(0.7);
  });

  it('falls back to RRF order on Cohere failure', async () => {
    vi.doMock('@/lib/llm/cohere', () => ({
      rerank: vi.fn().mockRejectedValue(new Error('cohere down')),
    }));
    const input = [chunk('A', 'a', 0.5), chunk('B', 'b', 0.4), chunk('C', 'c', 0.3)];
    const { rerank } = await import('@/lib/rag/reranker');
    const out = await rerank('q', input, 2);
    expect(out.map((c) => c.chunkId)).toEqual(['A', 'B']);
    expect(out[0]?.rerankScore).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run tests/lib/rag/reranker.test.ts
```

Expected: import errors.

- [ ] **Step 3: Implement `lib/rag/reranker.ts`**

Write `lib/rag/reranker.ts`:

```ts
import { rerank as cohereRerank } from '@/lib/llm/cohere';
import type { RetrievedChunk } from './types';

export async function rerank(
  query: string,
  chunks: RetrievedChunk[],
  topN: number,
): Promise<RetrievedChunk[]> {
  if (chunks.length === 0) return [];
  try {
    const hits = await cohereRerank(
      query,
      chunks.map((c) => c.content),
      topN,
    );
    return hits
      .map((h) => {
        const src = chunks[h.index];
        if (!src) return null;
        return { ...src, rerankScore: h.relevanceScore };
      })
      .filter((c): c is RetrievedChunk => c !== null);
  } catch (err) {
    console.warn('[rag/reranker] Cohere failed, falling back to RRF order:', err);
    return chunks.slice(0, topN);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run tests/lib/rag/reranker.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/rag/reranker.ts tests/lib/rag/reranker.test.ts
git commit -m "feat(rag): add reranker with Cohere fallback to RRF order"
```

---

## Task 8: `lib/rag/prompt-builder.ts` (TDD — pure function)

**Files:**
- Create: `lib/rag/prompt-builder.ts`
- Create: `tests/lib/rag/prompt-builder.test.ts`

- [ ] **Step 1: Write the failing tests**

Write `tests/lib/rag/prompt-builder.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Classification, RetrievedChunk } from '@/lib/rag/types';

function chunk(id: string, content: string, title: string): RetrievedChunk {
  return {
    chunkId: id,
    articleId: `art-${id}`,
    content,
    ord: 0,
    articleTitle: title,
    vectorRank: null,
    ftsRank: null,
    rrfScore: 0,
    rerankScore: null,
  };
}

const ptClass: Classification = {
  theory: null,
  intent: 'definition',
  language: 'pt',
  needsRetrieval: true,
};
const enClass: Classification = { ...ptClass, language: 'en' };

describe('rag prompt-builder', () => {
  it('builds numbered citation tokens for each chunk', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const result = buildPrompt(
      'O que é Kraljic?',
      [
        chunk('c1', 'Kraljic propôs em 1983...', 'A Matriz de Kraljic'),
        chunk('c2', 'Aplica-se classificando itens...', 'A Matriz de Kraljic'),
      ],
      ptClass,
    );
    expect(result.user).toContain('[1]');
    expect(result.user).toContain('[2]');
    expect(result.user).toContain('A Matriz de Kraljic');
    expect(result.user).toContain('Kraljic propôs em 1983');
    expect(result.sources.map((s) => s.number)).toEqual([1, 2]);
    expect(result.sources[0]?.chunkId).toBe('c1');
    expect(result.sources[1]?.chunkId).toBe('c2');
  });

  it('includes refusal instruction when chunks are empty', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const result = buildPrompt('?', [], ptClass);
    expect(result.system.toLowerCase()).toContain('não tem fonte');
    expect(result.system.toLowerCase()).toContain('não invente');
    expect(result.sources).toEqual([]);
    expect(result.user).toContain('?'); // user query still in there
  });

  it('flips language hint to English when classification.language=en', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const result = buildPrompt('What is Kraljic?', [], enClass);
    expect(result.system).toMatch(/respond in english/i);
    expect(result.system).not.toMatch(/responda em português/i);
  });

  it('uses Portuguese hint by default', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const result = buildPrompt('?', [], ptClass);
    expect(result.system).toMatch(/responda em português/i);
  });

  it('aligns sources[i].number with the [N] tokens in the user prompt', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const result = buildPrompt(
      'q',
      [chunk('a', 'A', 'TitleA'), chunk('b', 'B', 'TitleB'), chunk('c', 'C', 'TitleC')],
      ptClass,
    );
    for (const src of result.sources) {
      expect(result.user).toContain(`[${src.number}]`);
    }
  });

  it('includes the persona and 4-part response structure in system prompt', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const result = buildPrompt('q', [chunk('a', 'A', 'T')], ptClass);
    expect(result.system).toMatch(/especialista/i);
    expect(result.system).toMatch(/procurement/i);
    // Mentions the 4-part structure markers
    expect(result.system).toMatch(/resposta direta/i);
    expect(result.system).toMatch(/aplicação prática/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run tests/lib/rag/prompt-builder.test.ts
```

Expected: import errors.

- [ ] **Step 3: Implement `lib/rag/prompt-builder.ts`**

Write `lib/rag/prompt-builder.ts`:

```ts
import type { Classification, RetrievedChunk, SourceRef } from './types';

const PERSONA = `Você é um especialista sênior em procurement com 20 anos de experiência, formação acadêmica sólida (Kraljic, Porter, Monczka, Cox, Cousins, Dyer), didático mas direto. Sempre cita as fontes da base de conhecimento.`;

const RESPONSE_STRUCTURE = `Estrutura padrão de resposta:
1. Resposta direta (2-3 linhas)
2. Aprofundamento teórico, citando trechos da base com tokens [1], [2], etc.
3. Aplicação prática (exemplo ou caso curto)
4. Sugestão de leituras complementares (se houver fontes adicionais relevantes)`;

const REFUSAL_INSTRUCTION = `Você não tem fonte na base sobre esta pergunta. Diga isso explicitamente em uma frase. Não invente teoria, autor, framework, citação ou data. Você pode fazer uma pergunta de esclarecimento se ajudar a localizar uma teoria mencionada.`;

const CITATION_INSTRUCTION = `Cite as fontes usando os tokens [1], [2], etc. exatamente como aparecem no contexto abaixo, ao lado de cada afirmação técnica. Se uma afirmação não tiver respaldo no contexto, omita-a.`;

const LANGUAGE_HINT_PT = `Responda em português brasileiro, em tom profissional mas acessível.`;
const LANGUAGE_HINT_EN = `Respond in English, in a professional but accessible tone.`;

export function buildPrompt(
  query: string,
  chunks: RetrievedChunk[],
  classification: Classification,
): { system: string; user: string; sources: SourceRef[] } {
  const sources: SourceRef[] = chunks.map((c, i) => ({
    number: i + 1,
    articleId: c.articleId,
    articleTitle: c.articleTitle,
    chunkId: c.chunkId,
  }));

  const languageHint = classification.language === 'en' ? LANGUAGE_HINT_EN : LANGUAGE_HINT_PT;
  const contextInstruction = chunks.length === 0 ? REFUSAL_INSTRUCTION : CITATION_INSTRUCTION;

  const system = [PERSONA, RESPONSE_STRUCTURE, contextInstruction, languageHint].join('\n\n');

  const userParts: string[] = [];
  if (chunks.length > 0) {
    userParts.push('## Contexto da base de conhecimento');
    chunks.forEach((c, i) => {
      const n = i + 1;
      userParts.push(`### [${n}] ${c.articleTitle}\n\n${c.content}`);
    });
    userParts.push('---');
  }
  userParts.push('## Pergunta do usuário');
  userParts.push(query);

  return { system, user: userParts.join('\n\n'), sources };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run tests/lib/rag/prompt-builder.test.ts
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/rag/prompt-builder.ts tests/lib/rag/prompt-builder.test.ts
git commit -m "feat(rag): add prompt-builder with citation tokens and refusal branch"
```

---

## Task 9: `lib/rag/index.ts` orchestrator (TDD)

**Files:**
- Create: `lib/rag/index.ts`
- Create: `tests/lib/rag/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Write `tests/lib/rag/index.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { RetrievedChunk } from '@/lib/rag/types';

beforeEach(() => {
  vi.resetModules();
});

function chunk(id: string): RetrievedChunk {
  return {
    chunkId: id,
    articleId: `art-${id}`,
    content: `content ${id}`,
    ord: 0,
    articleTitle: `Title ${id}`,
    vectorRank: 1,
    ftsRank: null,
    rrfScore: 0.5,
    rerankScore: null,
  };
}

describe('rag runRag', () => {
  it('runs the full pipeline and returns sources + system + user + debug', async () => {
    vi.doMock('@/lib/rag/classifier', () => ({
      classify: vi.fn().mockResolvedValue({
        theory: 'kraljic',
        intent: 'definition',
        language: 'pt',
        needsRetrieval: true,
      }),
    }));
    const retrieved = [chunk('a'), chunk('b')];
    vi.doMock('@/lib/rag/retriever', () => ({
      retrieve: vi.fn().mockResolvedValue(retrieved),
    }));
    vi.doMock('@/lib/rag/reranker', () => ({
      rerank: vi.fn().mockResolvedValue([
        { ...retrieved[0]!, rerankScore: 0.9 },
      ]),
    }));

    const { runRag } = await import('@/lib/rag');
    const result = await runRag('o que é kraljic?');

    expect(result.classification.theory).toBe('kraljic');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.chunkId).toBe('a');
    expect(result.user).toContain('[1]');
    expect(result.system).toMatch(/especialista/i);
    expect(result.debug.totalMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.debug.classifyMs).toBe('number');
  });

  it('short-circuits retrieve and rerank when needsRetrieval is false', async () => {
    vi.doMock('@/lib/rag/classifier', () => ({
      classify: vi.fn().mockResolvedValue({
        theory: null,
        intent: 'smalltalk',
        language: 'pt',
        needsRetrieval: false,
      }),
    }));
    const retrieveSpy = vi.fn();
    const rerankSpy = vi.fn();
    vi.doMock('@/lib/rag/retriever', () => ({ retrieve: retrieveSpy }));
    vi.doMock('@/lib/rag/reranker', () => ({ rerank: rerankSpy }));

    const { runRag } = await import('@/lib/rag');
    const result = await runRag('oi');

    expect(retrieveSpy).not.toHaveBeenCalled();
    expect(rerankSpy).not.toHaveBeenCalled();
    expect(result.sources).toEqual([]);
    expect(result.system.toLowerCase()).toContain('não tem fonte');
  });

  it('handles empty retrieved chunks by going through buildPrompt empty branch', async () => {
    vi.doMock('@/lib/rag/classifier', () => ({
      classify: vi.fn().mockResolvedValue({
        theory: null,
        intent: 'definition',
        language: 'pt',
        needsRetrieval: true,
      }),
    }));
    vi.doMock('@/lib/rag/retriever', () => ({
      retrieve: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('@/lib/rag/reranker', () => ({
      rerank: vi.fn().mockResolvedValue([]),
    }));

    const { runRag } = await import('@/lib/rag');
    const result = await runRag('pergunta sem fonte');
    expect(result.sources).toEqual([]);
    expect(result.system.toLowerCase()).toContain('não tem fonte');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run tests/lib/rag/index.test.ts
```

Expected: import errors.

- [ ] **Step 3: Implement `lib/rag/index.ts`**

Write `lib/rag/index.ts`:

```ts
import { classify } from './classifier';
import { retrieve } from './retriever';
import { rerank } from './reranker';
import { buildPrompt } from './prompt-builder';
import type { RagResult, RetrievedChunk } from './types';

const RERANK_TOP_N = 8;

export async function runRag(query: string): Promise<RagResult> {
  const t0 = performance.now();

  const tClassifyStart = performance.now();
  const classification = await classify(query);
  const classifyMs = performance.now() - tClassifyStart;

  let chunks: RetrievedChunk[] = [];
  let embedMs = 0;
  let vectorMs = 0;
  let ftsMs = 0;
  let rerankMs = 0;

  if (classification.needsRetrieval) {
    const tRetrieveStart = performance.now();
    const candidates = await retrieve(query);
    const retrieveMs = performance.now() - tRetrieveStart;
    embedMs = retrieveMs;
    vectorMs = retrieveMs;
    ftsMs = retrieveMs;

    const tRerankStart = performance.now();
    chunks = await rerank(query, candidates, RERANK_TOP_N);
    rerankMs = performance.now() - tRerankStart;
  }

  const { system, user, sources } = buildPrompt(query, chunks, classification);

  return {
    classification,
    sources,
    system,
    user,
    debug: {
      classifyMs,
      embedMs,
      vectorMs,
      ftsMs,
      rerankMs,
      totalMs: performance.now() - t0,
    },
  };
}

export type { Classification, RetrievedChunk, SourceRef, RagResult } from './types';
```

Note: `embedMs`, `vectorMs`, `ftsMs` are coarse (single retrieve call timed as a whole). Sub-projeto 7 can break them apart by instrumenting `retrieve()` itself if finer timing is needed.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run tests/lib/rag/index.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Run all tests**

Run:

```bash
npm test
```

Expected: 39 passed (15 pre-existing + 2 voyage extension + 6 classifier + 4 retriever + 3 reranker + 6 prompt-builder + 3 index = 39).

- [ ] **Step 6: Typecheck**

Run:

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add lib/rag/index.ts tests/lib/rag/index.test.ts
git commit -m "feat(rag): add runRag orchestrator with timing"
```

---

## Task 10: CLI — `scripts/rag-query.ts` and `npm run rag:query`

**Files:**
- Create: `scripts/rag-query.ts`
- Modify: `package.json`

- [ ] **Step 1: Create the CLI script**

Write `scripts/rag-query.ts`:

```ts
#!/usr/bin/env tsx
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local') });

import { runRag } from '@/lib/rag';

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('Usage: npm run rag:query "<question>"');
    process.exit(2);
  }

  const result = await runRag(query);

  console.log('\n=== Classification ===');
  console.log(JSON.stringify(result.classification, null, 2));

  console.log('\n=== Sources (top after rerank) ===');
  if (result.sources.length === 0) {
    console.log('(no sources)');
  } else {
    for (const src of result.sources) {
      console.log(`  [${src.number}] ${src.articleTitle}  (chunk ${src.chunkId})`);
    }
  }

  console.log('\n=== System prompt (truncated 800 chars) ===');
  console.log(result.system.slice(0, 800) + (result.system.length > 800 ? '\n... (truncated)' : ''));

  console.log('\n=== User prompt (truncated 800 chars) ===');
  console.log(result.user.slice(0, 800) + (result.user.length > 800 ? '\n... (truncated)' : ''));

  console.log('\n=== Debug ===');
  console.log(JSON.stringify(result.debug, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add `dotenv` if not present**

Run:

```bash
node -e "require('dotenv')" 2>&1
```

If this errors with `Cannot find module 'dotenv'`, install it:

```bash
npm install dotenv@^16.4.5
```

If it returns nothing (no error), skip the install.

- [ ] **Step 3: Add the npm script**

Modify `package.json`. Inside the existing `"scripts"` object, add the line `"rag:query": "tsx scripts/rag-query.ts"` after `"format"`. The `scripts` block becomes:

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "next lint",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "test:watch": "vitest",
  "db:migrate": "supabase db push",
  "db:types": "supabase gen types typescript --linked > lib/db/database.types.ts",
  "format": "prettier --write .",
  "rag:query": "tsx scripts/rag-query.ts"
},
```

- [ ] **Step 4: Smoke-test the CLI (requires DB to have a Kraljic article from sub-projeto 2 Task 11)**

Run:

```bash
npm run rag:query -- "o que e a matriz de Kraljic?"
```

Expected:
- Classification block prints with `theory: "kraljic"` (or similar) and `needsRetrieval: true`
- At least one source with `articleTitle` containing "Kraljic"
- Debug timings populated
- Exit 0

If no Kraljic chunks exist, run `python scripts/ingest.py --file scripts/tests/fixtures/sample_pt.md` first.

- [ ] **Step 5: Commit**

```bash
git add scripts/rag-query.ts package.json package-lock.json
git commit -m "feat(rag): add rag:query CLI for ad-hoc retrieval debugging"
```

---

## Task 11: Eval harness — `scripts/eval/golden.json`, `scripts/eval/run.ts`, `npm run rag:eval`

**Files:**
- Create: `scripts/eval/golden.json`
- Create: `scripts/eval/run.ts`
- Modify: `package.json`

- [ ] **Step 1: Create the golden set**

Write `scripts/eval/golden.json`:

```json
[
  {
    "id": "kraljic-definition",
    "query": "O que é a matriz de Kraljic?",
    "expected_titles": ["A Matriz de Kraljic"],
    "intent": "definition"
  },
  {
    "id": "kraljic-quadrants",
    "query": "Quais são os quatro quadrantes da matriz de Kraljic?",
    "expected_titles": ["A Matriz de Kraljic"],
    "intent": "definition"
  },
  {
    "id": "kraljic-application",
    "query": "Como aplicar a matriz de Kraljic em um varejo de alimentos?",
    "expected_titles": ["A Matriz de Kraljic"],
    "intent": "application"
  },
  {
    "id": "strategic-sourcing-definition",
    "query": "What is strategic sourcing?",
    "expected_titles": ["Strategic Sourcing Fundamentals"],
    "intent": "definition"
  },
  {
    "id": "strategic-sourcing-principles",
    "query": "What are the core principles of strategic sourcing?",
    "expected_titles": ["Strategic Sourcing Fundamentals"],
    "intent": "definition"
  },
  {
    "id": "strategic-sourcing-application",
    "query": "How should we implement strategic sourcing in a manufacturing firm?",
    "expected_titles": ["Strategic Sourcing Fundamentals"],
    "intent": "application"
  },
  {
    "id": "porter-five-forces",
    "query": "Explique as cinco forças de Porter",
    "expected_titles": ["Porter's Five Forces"],
    "intent": "definition"
  },
  {
    "id": "porter-vs-kraljic",
    "query": "Qual a diferença entre Porter e Kraljic em compras estratégicas?",
    "expected_titles": ["A Matriz de Kraljic", "Porter's Five Forces"],
    "intent": "comparison"
  },
  {
    "id": "porter-application",
    "query": "Como usar as forças de Porter para avaliar um setor?",
    "expected_titles": ["Porter's Five Forces"],
    "intent": "application"
  },
  {
    "id": "smalltalk-greeting",
    "query": "oi, tudo bem?",
    "expected_titles": [],
    "intent": "smalltalk"
  }
]
```

- [ ] **Step 2: Create the eval runner**

Write `scripts/eval/run.ts`:

```ts
#!/usr/bin/env tsx
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '@/lib/db/supabase';
import { runRag } from '@/lib/rag';

type GoldenRow = {
  id: string;
  query: string;
  expected_titles: string[];
  intent: string;
};

type RowResult = {
  id: string;
  intent: string;
  hit: boolean | 'inconclusive' | 'n/a';
  rank: number | null;
  smalltalkSkippedCorrectly: boolean | null;
  totalMs: number;
};

async function resolveExpectedIds(
  rows: GoldenRow[],
): Promise<Map<string, Set<string>>> {
  const allTitles = [...new Set(rows.flatMap((r) => r.expected_titles))];
  if (allTitles.length === 0) return new Map();
  const supabase = getServerSupabase();
  const { data, error } = await supabase.from('articles').select('id,title').in('title', allTitles);
  if (error) throw new Error(`articles lookup failed: ${error.message}`);
  const titleToId = new Map<string, string>();
  for (const a of (data as { id: string; title: string }[]) ?? []) {
    titleToId.set(a.title, a.id);
  }
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    const ids = new Set<string>();
    for (const t of row.expected_titles) {
      const id = titleToId.get(t);
      if (id) ids.add(id);
    }
    out.set(row.id, ids);
  }
  return out;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function main() {
  const goldenPath = resolve(process.cwd(), 'scripts/eval/golden.json');
  const rows = JSON.parse(readFileSync(goldenPath, 'utf-8')) as GoldenRow[];
  const expectedIds = await resolveExpectedIds(rows);

  const results: RowResult[] = [];

  for (const row of rows) {
    const ragResult = await runRag(row.query);
    const expected = expectedIds.get(row.id) ?? new Set<string>();

    let hit: RowResult['hit'];
    let rank: number | null = null;
    let smalltalkSkippedCorrectly: boolean | null = null;

    if (row.intent === 'smalltalk') {
      smalltalkSkippedCorrectly = !ragResult.classification.needsRetrieval;
      hit = 'n/a';
    } else if (expected.size === 0) {
      hit = 'inconclusive';
    } else {
      const top5 = ragResult.sources.slice(0, 5).map((s) => s.articleId);
      const idx = top5.findIndex((id) => expected.has(id));
      if (idx >= 0) {
        hit = true;
        rank = idx + 1;
      } else {
        hit = false;
      }
    }

    results.push({
      id: row.id,
      intent: row.intent,
      hit,
      rank,
      smalltalkSkippedCorrectly,
      totalMs: Math.round(ragResult.debug.totalMs),
    });
  }

  // Aggregate
  const scoreable = results.filter((r) => r.hit === true || r.hit === false);
  const hits = scoreable.filter((r) => r.hit === true);
  const recallAt5 = scoreable.length > 0 ? hits.length / scoreable.length : 0;
  const mrr =
    scoreable.length > 0
      ? scoreable.reduce((acc, r) => acc + (r.rank ? 1 / r.rank : 0), 0) / scoreable.length
      : 0;
  const smalltalk = results.filter((r) => r.intent === 'smalltalk');
  const smalltalkCorrect = smalltalk.filter((r) => r.smalltalkSkippedCorrectly === true).length;
  const smalltalkRate = smalltalk.length > 0 ? smalltalkCorrect / smalltalk.length : 1;
  const meanLatency =
    results.length > 0 ? results.reduce((acc, r) => acc + r.totalMs, 0) / results.length : 0;

  console.log('\n| id | intent | hit | rank | latency_ms |');
  console.log('|---|---|---|---|---|');
  for (const r of results) {
    const hitStr = r.hit === true ? 'HIT' : r.hit === false ? 'miss' : String(r.hit);
    const rankStr = r.rank ? String(r.rank) : '-';
    console.log(
      `| ${pad(r.id, 30)} | ${pad(r.intent, 14)} | ${pad(hitStr, 12)} | ${pad(rankStr, 4)} | ${pad(String(r.totalMs), 8)} |`,
    );
  }
  console.log('');
  console.log(`recall@5            : ${recallAt5.toFixed(2)} (${hits.length}/${scoreable.length})`);
  console.log(`MRR                 : ${mrr.toFixed(3)}`);
  console.log(`smalltalk-skip-rate : ${smalltalkRate.toFixed(2)} (${smalltalkCorrect}/${smalltalk.length})`);
  console.log(`mean total latency  : ${meanLatency.toFixed(0)} ms`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Add the npm script**

Modify `package.json`. Add `"rag:eval": "tsx scripts/eval/run.ts"` after the `rag:query` line. The scripts block now ends with:

```json
  "rag:query": "tsx scripts/rag-query.ts",
  "rag:eval": "tsx scripts/eval/run.ts"
},
```

- [ ] **Step 4: Smoke-test the eval (requires fixtures ingested)**

If the three fixture articles (`A Matriz de Kraljic`, `Strategic Sourcing Fundamentals`, `Porter's Five Forces`) are not yet in the DB, ingest them:

```bash
python scripts/ingest.py --path scripts/tests/fixtures/
```

Then:

```bash
npm run rag:eval
```

Expected:
- A markdown table with 10 rows
- `recall@5 ≥ 0.6` (6+ hits out of 9 scoreable rows)
- `smalltalk-skip-rate = 1.00` (the 1 smalltalk row gets `needsRetrieval=false`)
- Mean latency under ~5000 ms
- Exit 0

If `recall@5 < 0.6`, do not "tune until green" — log the failure as a finding for sub-projeto 7. The bar is intentionally low; missing it suggests the corpus or RPC is broken.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval/golden.json scripts/eval/run.ts package.json
git commit -m "feat(rag): add golden-set eval harness with recall@5 and MRR"
```

---

## Task 12: Final smoke + tag

**Files:** none new — final verification across the suite.

- [ ] **Step 1: Run all unit tests**

Run:

```bash
npm test
```

Expected: 39 passed.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Confirm pytest still green**

Run:

```bash
scripts/.venv/Scripts/pytest.exe scripts/tests/ -q
```

Expected: 23 passed.

- [ ] **Step 4: Confirm `/api/health` still 200**

Start the dev server in one terminal:

```bash
npm run dev
```

In another terminal:

```bash
curl -s http://localhost:3000/api/health
```

Expected: `{"ok":true,"checks":{"supabase":"ok","voyage":"ok","cohere":"ok","google":"ok"},...}`. Stop dev server (Ctrl+C).

- [ ] **Step 5: One more rag:query for the record**

Run:

```bash
npm run rag:query -- "qual a aplicação prática da matriz de Kraljic?"
```

Expected:
- Top source has `articleTitle: "A Matriz de Kraljic"` after rerank
- Classification has `intent: "application"` and `needsRetrieval: true`
- Exit 0

- [ ] **Step 6: One more rag:eval for the record**

Run:

```bash
npm run rag:eval
```

Expected: same metrics as Task 11 Step 4 (recall@5 ≥ 0.6, smalltalk-skip-rate 1.00).

- [ ] **Step 7: Tag the milestone**

```bash
git tag -a retrieval-complete -m "Sub-projeto 3 (Retrieval) complete — runRag works end-to-end with hybrid + rerank + classifier; eval harness in place"
```

---

## Self-Review Notes

**Spec coverage check:**
- Spec §2 Objetivo (5 modules + migration + CLI + eval) → Tasks 2 (migration), 3 (types), 5-9 (modules), 10 (CLI), 11 (eval)
- Spec §3 Stack (zod, tsx) → Task 1
- Spec §4 Estrutura → Task 1 (deps), per-task file additions match the table
- Spec §5 Migration (RPCs, security definer, websearch_to_tsquery, grants) → Task 2
- Spec §6 Componentes — contratos:
  - 6.1 types.ts → Task 3
  - 6.2 classifier.ts (gemini SDK shape, responseSchema, zod, safe-default) → Task 5
  - 6.3 retriever.ts (voyage extension + RPC pair + RRF + dedup + title join) → Tasks 4 + 6
  - 6.4 reranker.ts (Cohere wrapper, index mapping, fallback, rerankScore) → Task 7
  - 6.5 prompt-builder.ts (persona, structure, citation tokens, empty branch, language hint) → Task 8
  - 6.6 index.ts (orchestrator + short-circuit + debug timings) → Task 9
- Spec §7 Eval + CLI → Tasks 10, 11
- Spec §8 Tests → Tasks 4, 5, 6, 7, 8, 9 (each has TDD)
- Spec §9 Integration smoke → Tasks 10 Step 4, 11 Step 4, 12 Steps 5-6
- Spec §10 Critérios de sucesso #1-7 → covered by Tasks 2 (#1), 9 (#2,#3,#4 partial), 10 (#5), 11 (#6), 12 (#7 tag)

Every spec section maps to ≥ 1 task.

**Placeholder scan:** No "TBD", "implement later", "similar to". Each step has actual code or actual command. Two intentional notes: (a) the `embedMs/vectorMs/ftsMs` triple in Task 9 is documented as "coarse" — sub-projeto 7 can refine; (b) Task 11 Step 4 explicitly says "do not tune until green" if the bar is missed.

**Type consistency check:**
- `Classification` (theory, intent, language, needsRetrieval) — defined Task 3, used in Tasks 5, 8, 9. Match.
- `Intent` enum (definition, application, comparison, recommendation, smalltalk) — defined Task 3, used in Tasks 5 (zod enum), 11 (golden rows). Match.
- `RetrievedChunk` (chunkId, articleId, content, ord, articleTitle, vectorRank, ftsRank, rrfScore, rerankScore) — defined Task 3, produced by Task 6, mutated by Task 7, consumed by Task 8. Field names match in every task.
- `SourceRef` (number, articleId, articleTitle, chunkId) — defined Task 3, produced by Task 8, returned in Task 9's RagResult. Match.
- `RagDebug` and `RagResult` — defined Task 3, populated in Task 9, consumed in Tasks 10, 11. Match.
- `embed(texts, inputType?)` — extended in Task 4, consumed in Task 6 with `'query'`. Match.
- `cohereRerank(query, documents, topN)` returns `RerankHit[]` with `{ index, relevanceScore }` — confirmed in code, Task 7 maps `hits.map(h => chunks[h.index])` and reads `h.relevanceScore`. Match.
- `runRag(query)` signature — defined Task 9, called in Tasks 10 (CLI), 11 (eval). Match.
- `getServerSupabase()` — exists in `lib/db/supabase.ts`, used by Tasks 6, 11. Match.
- `getGemini()` returns SDK with `models.generateContent({...})` — confirmed in `lib/llm/gemini.ts`, used in Task 5. Match.
- Migration name `00000000000002_rag_rpc.sql` follows the existing `00000000000000_init.sql` / `00000000000001_articles_hash_unique.sql` convention. Match.

**Spec gaps caught and addressed inline during writing:**
- Spec §6.3 says "embed via voyage with input_type='query'" but Voyage wrapper didn't accept it → Task 4 extends the wrapper (with backward-compat default, two new tests).
- Task 10 Step 2 includes a defensive install-if-missing for `dotenv`, since the Python ingest uses python-dotenv but Node does not have it as a dep yet.
- Task 9 explicitly notes that `embedMs/vectorMs/ftsMs` are coarse — to avoid the engineer over-engineering instrumentation in scope.

**Test count budget:** 6 (classifier) + 4 (retriever) + 3 (reranker) + 6 (prompt-builder) + 3 (index) + 2 (voyage extension) = 24 new vitest tests, on top of 15 existing → 39 total. Pytest 23 unchanged.
