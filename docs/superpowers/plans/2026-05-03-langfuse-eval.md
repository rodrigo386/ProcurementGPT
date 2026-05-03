# Langfuse + Eval Framework + CI Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Langfuse into production chat with 6 nested RAG sub-spans, expand the golden eval set from 10 → 25 pairs with batched embedding, and add a GitHub Actions workflow that gates PR + main on `recall@5 ≥ 0.85`. Closes milestone 1.

**Architecture:** Single `lib/observability/langfuse.ts` wrapper with no-op fallback when keys are absent. `runRag` accepts an optional `parentTrace` and opens spans around `classify` / `retrieve` / `rerank` / `build-prompt`. `/api/chat` opens the trace, threads it through, opens its own spans around `condenseQuery` and `streamText`, and `await flushAsync()` inside `onFinish` (and the catch / abort paths) so traces survive Edge runtime termination. Eval CLI batches all 25 query embeds into one Voyage call (eliminates the 21s/embed throttle), opens one Langfuse session per run tagged `env:ci`, and exits 1 when recall drops below threshold. CI runs `typecheck + vitest + pytest + rag:eval` on PR + push to main, uploads `results.json` artifact, posts the per-pair table as a PR comment.

**Tech Stack:** `langfuse` npm package (multi-runtime client), GitHub Actions, existing stack unchanged.

**Spec:** `docs/superpowers/specs/2026-05-03-langfuse-eval-design.md`

**Spec correction (apply during plan execution):** Spec §4 lists "MODIFY: optional span arg" against `condenser.ts`, `classifier.ts`, `reranker.ts`, `prompt-builder.ts`. That's wrong — §5.3's pseudocode is correct. The orchestrator (`runRag` and `/api/chat` route) opens spans around the helper *calls*; the helpers themselves are not modified. Only `retriever.ts` gets a real change (`preEmbedded` opt for eval batching).

---

## File Structure & Responsibility Map

| File | Responsibility |
|------|----------------|
| `package.json` + lock | MODIFY — add `langfuse` runtime dep |
| `lib/observability/types.ts` | NEW — `Trace`, `Span`, `TraceLevel` interfaces |
| `lib/observability/langfuse.ts` | NEW — `startTrace` + `flushAsync`, dynamic `langfuse` import, no-op when env keys missing |
| `lib/rag/retriever.ts` | MODIFY — accept `opts.preEmbedded` to skip embed call |
| `lib/rag/index.ts` | MODIFY — accept `opts.parentTrace`, open spans around classify/retrieve/rerank/build-prompt |
| `app/api/chat/route.ts` | MODIFY — `startTrace`, span around condense + streamText, flush in onFinish/catch (abort detected via `finishReason === 'abort'`) |
| `components/chat/ChatSession.tsx` | MODIFY — pass `body: { sessionId: session.id }` to `useChat` |
| `scripts/eval/golden.json` | EXPAND — 10 → 25 pairs (5 angles × 4 articles + 2 smalltalk + 3 multi-source comparison) |
| `scripts/eval/run.ts` | MODIFY — Langfuse session, batch all embeds via Voyage in one call, `_preEmbeddedQuery` per pair, exit 1 on recall < 0.85, write `scripts/eval/results.json` |
| `.github/workflows/ci.yml` | NEW — typecheck + vitest + pytest + rag:eval on PR + push to main, artifact upload, PR comment |
| `tests/lib/observability/langfuse.test.ts` | NEW — 4 tests (no-op when key missing, no-op when key empty, live wrapper calls trace correctly, flushAsync no-op without client) |
| `tests/lib/rag/index.test.ts` | MODIFY — +1 test that runRag opens spans on the provided parentTrace |
| `tests/scripts/eval/run.test.ts` | NEW — 2 tests (exit 0 when recall@5 ≥ 0.85, exit 1 + correct output when below) |
| `CLAUDE.md` | MODIFY — sub-projeto 7 row, observability principle, CI gate, new file paths |

**Test budget:** 136 prior + 7 new = **143 vitest**. Pytest 23/23 unchanged. Golden eval: 10 → 25 pairs.

**Prerequisite that's not in code:** the apostila article currently in DB has the bad title `036.310.189-67 Celso Rudey` (ingested before sub-projeto 6c's clean+metadata fixes). 6 of the 25 eval pairs (16-20, 24, 25) reference it by the corrected title `Apostila Compras Sustentáveis`. Task 2 deletes + re-ingests it before Task 12 (baseline eval) so those pairs resolve.

---

## Task 1: Add `langfuse` dep

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install**

```bash
npm install langfuse
```

Expected: success. `langfuse` appears in `dependencies` of `package.json`.

- [ ] **Step 2: Typecheck stays clean**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Stage**

```bash
git add package.json package-lock.json
```

Do NOT commit (controller commits per task).

---

## Task 2: Prerequisite — re-ingest the apostila article

**Files:** none — DB-only operation done via `/admin/articles` and `/admin/ingest` in the running dev server.

This task is manual but required so eval pairs 16-20, 24, 25 resolve.

- [ ] **Step 1: Verify the bad row exists**

```bash
scripts/.venv/Scripts/python.exe -c "
import sys; sys.path.insert(0, '.')
from scripts.ingest import load_env, connect_db
load_env()
conn = connect_db()
with conn.cursor() as cur:
    cur.execute(\"select id, title, length(raw_md) from articles where title like '%036.310.189-67%' or title like '%Apostila Compras%'\")
    for r in cur.fetchall(): print(r)
conn.close()
"
```

Expected: one row with title starting `036.310.189-67`.

- [ ] **Step 2: Start dev server (if not already running)**

```bash
npm run dev > .dev-srv.log 2>&1 &
```

(Controller runs this per memory `dev_server_workflow.md`.) Poll for `Ready in` in the log.

- [ ] **Step 3: Manual — delete the article via /admin/articles**

In the browser at `http://localhost:3000/admin/articles`:
- Click the row whose title is `036.310.189-67 Celso Rudey`
- Click `Excluir` in the right panel
- Confirm

- [ ] **Step 4: Manual — re-upload the same PDF via /admin/ingest**

In the browser at `http://localhost:3000/admin/ingest`:
- Drag the apostila PDF onto the dropzone (or click and select)
- Wait for the live card to progress through parsing → chunking → embedding → done
- Should take ~30-90s for ~125 pages

- [ ] **Step 5: Verify the new title and chunk count**

```bash
scripts/.venv/Scripts/python.exe -c "
import sys; sys.path.insert(0, '.')
from scripts.ingest import load_env, connect_db
load_env()
conn = connect_db()
with conn.cursor() as cur:
    cur.execute(\"select id, title, length(raw_md), (select count(*) from chunks where article_id=a.id) from articles a where title ilike '%apostila%' or title ilike '%sustent%'\")
    for r in cur.fetchall(): print(r)
conn.close()
"
```

Expected: one row with title `Apostila Compras Sustentáveis` (or close — the cleaner may pick a different first plausible line), `length(raw_md)` ~233k (down from 271k after cleaning), chunks count ~70-80 (down from 97 because cleaner removed noise that was eating chunk budget).

If the title is something other than `Apostila Compras Sustentáveis`, **update Task 10's golden.json `expected_titles` for pairs 16-20, 24, 25 to whatever the actual title resolves to**.

---

## Task 3: `lib/observability/types.ts` + `lib/observability/langfuse.ts` (TDD)

**Files:**
- Create: `lib/observability/types.ts`, `lib/observability/langfuse.ts`
- Create: `tests/lib/observability/langfuse.test.ts`

- [ ] **Step 1: Create `lib/observability/types.ts`**

```ts
export type TraceLevel = 'DEFAULT' | 'WARNING' | 'ERROR';

export interface Span {
  end(output?: unknown, level?: TraceLevel): void;
}

export interface Trace {
  span(name: string, input?: unknown): Span;
  end(output?: unknown, level?: TraceLevel): void;
  setMetadata(key: string, value: unknown): void;
  setTag(tag: string): void;
}
```

- [ ] **Step 2: Write failing tests at `tests/lib/observability/langfuse.test.ts`**

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_PUBLIC_KEY;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('lib/observability/langfuse', () => {
  it('startTrace returns a no-op trace when LANGFUSE_SECRET_KEY is missing', async () => {
    const { startTrace } = await import('@/lib/observability/langfuse');
    const trace = await startTrace({ name: 'test' });
    const span = trace.span('child');
    // Should not throw and should be safe to call all methods
    span.end({ ok: true });
    trace.setMetadata('k', 'v');
    trace.setTag('tag');
    trace.end({ ok: true }, 'DEFAULT');
    expect(trace).toBeDefined();
  });

  it('startTrace returns a no-op trace when keys are empty strings', async () => {
    process.env.LANGFUSE_SECRET_KEY = '';
    process.env.LANGFUSE_PUBLIC_KEY = '';
    const { startTrace } = await import('@/lib/observability/langfuse');
    const trace = await startTrace({ name: 'test' });
    expect(() => trace.span('x').end()).not.toThrow();
    expect(() => trace.end()).not.toThrow();
  });

  it('startTrace creates a real Langfuse trace when keys are present', async () => {
    process.env.LANGFUSE_SECRET_KEY = 'sk-test';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
    const lfTraceUpdate = vi.fn();
    const lfSpanEnd = vi.fn();
    const lfTraceSpan = vi.fn().mockReturnValue({ end: lfSpanEnd });
    const lfTrace = vi.fn().mockReturnValue({ update: lfTraceUpdate, span: lfTraceSpan });
    const flushAsync = vi.fn().mockResolvedValue(undefined);
    const Langfuse = vi.fn().mockImplementation(() => ({ trace: lfTrace, flushAsync }));
    vi.doMock('langfuse', () => ({ Langfuse }));

    const obs = await import('@/lib/observability/langfuse');
    const trace = await obs.startTrace({
      name: 'chat.turn',
      userId: 'u1',
      sessionId: 's1',
      input: { msg: 'hi' },
      tags: ['env:production'],
    });
    expect(Langfuse).toHaveBeenCalledWith(
      expect.objectContaining({ secretKey: 'sk-test', publicKey: 'pk-test' }),
    );
    expect(lfTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'chat.turn',
        userId: 'u1',
        sessionId: 's1',
        tags: ['env:production'],
      }),
    );
    const span = trace.span('classify', { q: 'foo' });
    span.end({ ok: true }, 'DEFAULT');
    expect(lfTraceSpan).toHaveBeenCalledWith({ name: 'classify', input: { q: 'foo' } });
    expect(lfSpanEnd).toHaveBeenCalledWith({ output: { ok: true }, level: 'DEFAULT' });

    trace.end({ done: true }, 'ERROR');
    expect(lfTraceUpdate).toHaveBeenCalledWith({ output: { done: true }, level: 'ERROR' });

    await obs.flushAsync();
    expect(flushAsync).toHaveBeenCalled();
  });

  it('flushAsync resolves immediately when no client was instantiated', async () => {
    const { flushAsync } = await import('@/lib/observability/langfuse');
    await expect(flushAsync()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run tests/lib/observability/langfuse.test.ts
```

Expected: import error (module does not exist).

- [ ] **Step 4: Implement `lib/observability/langfuse.ts`**

```ts
import type { Trace, Span, TraceLevel } from './types';

const NOOP_SPAN: Span = { end() {} };
const NOOP_TRACE: Trace = {
  span: () => NOOP_SPAN,
  end: () => {},
  setMetadata: () => {},
  setTag: () => {},
};

let cachedClient: { trace: (opts: unknown) => unknown; flushAsync: () => Promise<void> } | null = null;

export async function startTrace(opts: {
  name: string;
  userId?: string;
  sessionId?: string;
  input?: unknown;
  tags?: string[];
  metadata?: Record<string, unknown>;
}): Promise<Trace> {
  const secret = process.env.LANGFUSE_SECRET_KEY;
  const pub = process.env.LANGFUSE_PUBLIC_KEY;
  if (!secret || !pub) return NOOP_TRACE;

  if (!cachedClient) {
    const { Langfuse } = await import('langfuse');
    cachedClient = new Langfuse({
      secretKey: secret,
      publicKey: pub,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
    }) as unknown as typeof cachedClient;
  }

  const lfTrace = (cachedClient as NonNullable<typeof cachedClient>).trace({
    name: opts.name,
    userId: opts.userId,
    sessionId: opts.sessionId,
    input: opts.input,
    tags: opts.tags,
    metadata: opts.metadata,
  }) as { update: (p: unknown) => void; span: (p: unknown) => { end: (p: unknown) => void } };

  return {
    span(name, input) {
      const lfSpan = lfTrace.span({ name, input });
      return {
        end(output, level) {
          lfSpan.end({ output, level });
        },
      };
    },
    end(output, level) {
      lfTrace.update({ output, level });
    },
    setMetadata(key, value) {
      lfTrace.update({ metadata: { [key]: value } });
    },
    setTag(tag) {
      lfTrace.update({ tags: [tag] });
    },
  };
}

export async function flushAsync(): Promise<void> {
  if (!cachedClient) return;
  await cachedClient.flushAsync();
}

// Test-only: lets tests reset the module-scoped cache between cases.
export function _resetClientForTests(): void {
  cachedClient = null;
}
```

- [ ] **Step 5: Run tests to verify pass**

```bash
npx vitest run tests/lib/observability/langfuse.test.ts
```

Expected: 4 passed. If the third test fails because `cachedClient` persists across `vi.resetModules()`, add `obs._resetClientForTests()` at the top of the third test or `vi.unstubAllEnvs()` between cases — the `vi.resetModules()` call in `beforeEach` should already give each test a fresh module scope.

- [ ] **Step 6: Stage**

```bash
git add lib/observability/types.ts lib/observability/langfuse.ts tests/lib/observability/langfuse.test.ts
```

---

## Task 4: `lib/rag/retriever.ts` — accept `preEmbedded`

**Files:**
- Modify: `lib/rag/retriever.ts`

No new tests — this is a single-line behavior addition tested transitively by Task 5's runRag tests + the eval pipeline.

- [ ] **Step 1: Update the signature and embed call**

Open `lib/rag/retriever.ts`. Change the `RetrieveOptions` type and the `embed` call inside `retrieve`:

```ts
export type RetrieveOptions = {
  vectorK?: number;
  ftsK?: number;
  rrfK?: number;
  outK?: number;
  /** Internal hook for eval batching: skip embed call if vector already known. */
  preEmbedded?: number[];
};
```

Replace this block at the top of the function body:

```ts
const [embedding] = await embed([query], 'query');
if (!embedding) return [];
```

with:

```ts
const embedding = opts.preEmbedded ?? (await embed([query], 'query'))[0];
if (!embedding) return [];
```

Everything else stays unchanged.

- [ ] **Step 2: Verify retriever tests still pass + typecheck**

```bash
npx vitest run tests/lib/rag/retriever.test.ts
npm run typecheck
```

Expected: existing retriever tests stay green. Zero typecheck errors.

- [ ] **Step 3: Stage**

```bash
git add lib/rag/retriever.ts
```

---

## Task 5: `lib/rag/index.ts` — accept `parentTrace` (TDD)

**Files:**
- Modify: `lib/rag/index.ts`
- Modify: `tests/lib/rag/index.test.ts` (add 1 test)

- [ ] **Step 1: Add the failing test to `tests/lib/rag/index.test.ts`**

Append (inside the `describe('rag runRag', () => { ... })` block, before its closing `});`):

```ts
  it('opens spans on a provided parentTrace for classify, retrieve, rerank, build-prompt', async () => {
    vi.doMock('@/lib/rag/classifier', () => ({
      classify: vi.fn().mockResolvedValue({
        theory: 'kraljic', intent: 'definition', language: 'pt', needsRetrieval: true,
      }),
    }));
    const retrieved = [chunk('a'), chunk('b')];
    vi.doMock('@/lib/rag/retriever', () => ({
      retrieve: vi.fn().mockResolvedValue(retrieved),
    }));
    vi.doMock('@/lib/rag/reranker', () => ({
      rerank: vi.fn().mockResolvedValue([{ ...retrieved[0]!, rerankScore: 0.9 }]),
    }));

    const spans: Array<{ name: string; ended: boolean }> = [];
    const trace = {
      span: (name: string) => {
        const entry = { name, ended: false };
        spans.push(entry);
        return { end: () => { entry.ended = true; } };
      },
      end: () => {},
      setMetadata: () => {},
      setTag: () => {},
    };

    const { runRag } = await import('@/lib/rag');
    await runRag('o que é Kraljic?', { parentTrace: trace });
    const names = spans.map((s) => s.name);
    expect(names).toEqual(['classify', 'retrieve', 'rerank', 'build-prompt']);
    expect(spans.every((s) => s.ended)).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/rag/index.test.ts
```

Expected: prior tests still pass; new test fails because `runRag` doesn't accept `opts` yet (`Cannot read properties of undefined (reading 'parentTrace')` or similar).

- [ ] **Step 3: Update `lib/rag/index.ts`**

Replace the entire file with:

```ts
import { classify } from './classifier';
import { retrieve } from './retriever';
import { rerank } from './reranker';
import { buildPrompt } from './prompt-builder';
import type { RagResult, RetrievedChunk } from './types';
import type { Trace } from '@/lib/observability/types';

const RERANK_TOP_N = 8;

export type RunRagOpts = {
  parentTrace?: Trace;
  /** Internal hook for eval batching: skip embed call if vector already known. */
  _preEmbeddedQuery?: number[];
};

export async function runRag(query: string, opts: RunRagOpts = {}): Promise<RagResult> {
  const t0 = performance.now();
  const trace = opts.parentTrace;

  const tClassifyStart = performance.now();
  const classifySpan = trace?.span('classify', { query });
  const classification = await classify(query);
  classifySpan?.end({ classification });
  const classifyMs = performance.now() - tClassifyStart;

  let chunks: RetrievedChunk[] = [];
  let embedMs = 0;
  let vectorMs = 0;
  let ftsMs = 0;
  let rerankMs = 0;

  if (classification.needsRetrieval) {
    const tRetrieveStart = performance.now();
    const retrieveSpan = trace?.span('retrieve', { query, k: 30 });
    const candidates = await retrieve(query, { preEmbedded: opts._preEmbeddedQuery });
    retrieveSpan?.end({ count: candidates.length });
    const retrieveMs = performance.now() - tRetrieveStart;
    embedMs = retrieveMs;
    vectorMs = retrieveMs;
    ftsMs = retrieveMs;

    const tRerankStart = performance.now();
    const rerankSpan = trace?.span('rerank', { candidates: candidates.length });
    chunks = await rerank(query, candidates, RERANK_TOP_N);
    rerankSpan?.end({ kept: chunks.length });
    rerankMs = performance.now() - tRerankStart;
  }

  const promptSpan = trace?.span('build-prompt', { sources: chunks.length });
  const { system, user, sources } = buildPrompt(query, chunks, classification);
  promptSpan?.end({ systemLen: system.length, userLen: user.length });

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

- [ ] **Step 4: Run all rag tests + typecheck**

```bash
npx vitest run tests/lib/rag/
npm run typecheck
```

Expected: existing 6 rag test files green + the new test in index.test.ts passes. Zero typecheck errors.

Note: when `classification.needsRetrieval` is false (smalltalk), the `retrieve` and `rerank` spans aren't opened — only `classify` and `build-prompt`. The test above uses `needsRetrieval: true` so all 4 spans appear. If you also want a smalltalk-path test, add another it() that verifies only `classify` and `build-prompt` spans open.

- [ ] **Step 5: Stage**

```bash
git add lib/rag/index.ts tests/lib/rag/index.test.ts
```

---

## Task 6: `components/chat/ChatSession.tsx` — pass `sessionId`

**Files:**
- Modify: `components/chat/ChatSession.tsx`

No new tests — UI wiring covered by the manual smoke in Task 9.

- [ ] **Step 1: Add `body` to the `useChat` call**

Open `components/chat/ChatSession.tsx`. Find the `useChat({ ... })` call and add a `body` field passing `session.id`:

```diff
   const { messages, input, setInput, handleSubmit, isLoading, stop } = useChat({
     api: '/api/chat',
     id: session.id,
+    body: { sessionId: session.id },
     initialMessages: session.messages.map((m, i) => ({
       id: `${session.id}-${i}`,
       role: m.role,
       content: m.content,
     })),
```

The AI SDK merges `body` into every POST to `/api/chat`. So the chat route receives `{ messages, sessionId }`.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Stage**

```bash
git add components/chat/ChatSession.tsx
```

---

## Task 7: `app/api/chat/route.ts` — instrumentation

**Files:**
- Modify: `app/api/chat/route.ts`

No new tests — Edge route is covered by manual smoke (Task 9).

- [ ] **Step 1: Replace the file**

Replace the entire content of `app/api/chat/route.ts` with:

```ts
import { z } from 'zod';
import { streamText, StreamData } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { requireEnv } from '@/lib/env';
import { runRag } from '@/lib/rag';
import { condenseQuery } from '@/lib/rag/condenser';
import type { ChatMessage } from '@/lib/rag/types';
import { startTrace, flushAsync } from '@/lib/observability/langfuse';
import { requireUser } from '@/lib/auth';
import type { TraceLevel } from '@/lib/observability/types';

export const runtime = 'edge';

const Body = z
  .object({
    messages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().min(1),
        }),
      )
      .min(1),
    sessionId: z.string().uuid().optional(),
  })
  .refine(
    (b) => b.messages.length > 0 && b.messages[b.messages.length - 1]!.role === 'user',
    { message: 'last message must be from user' },
  );

export async function POST(req: Request): Promise<Response> {
  let parsed;
  try {
    const json = await req.json();
    parsed = Body.parse(json);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'invalid body' },
      { status: 400 },
    );
  }

  const messages: ChatMessage[] = parsed.messages;

  // Best-effort user lookup. Edge route is anon-callable today; if the cookie
  // resolves to a user, attach userId; if not, trace with userId=undefined.
  let userId: string | undefined;
  try {
    const user = await requireUser();
    userId = user.id;
  } catch {
    // unauth path: tracing still works without userId
  }

  const trace = await startTrace({
    name: 'chat.turn',
    userId,
    sessionId: parsed.sessionId,
    input: { messages },
    tags: ['env:production'],
  });

  try {
    const condenseSpan = trace.span('condense', { messages });
    const standalone = await condenseQuery(messages);
    condenseSpan.end({ standalone });

    const rag = await runRag(standalone, { parentTrace: trace });

    const history = messages.slice(0, -1);
    const llmMessages: ChatMessage[] = [
      ...history,
      { role: 'user', content: rag.user },
    ];

    const google = createGoogleGenerativeAI({
      apiKey: requireEnv('GOOGLE_API_KEY'),
    });

    const data = new StreamData();
    data.appendMessageAnnotation({
      sources: rag.sources,
      classification: rag.classification,
      debug: rag.debug,
    });

    const generateSpan = trace.span('generate', { systemLen: rag.system.length });

    const result = streamText({
      model: google(requireEnv('GEMINI_MODEL')),
      system: rag.system,
      messages: llmMessages,
      onFinish: async ({ text, usage, finishReason }) => {
        generateSpan.end({
          tokens_in: usage?.promptTokens ?? null,
          tokens_out: usage?.completionTokens ?? null,
          finish_reason: finishReason,
          chars_out: text.length,
        });
        const aborted = finishReason === 'abort' || finishReason === 'cancelled';
        const level: TraceLevel = aborted ? 'WARNING' : 'DEFAULT';
        if (aborted) trace.setTag('aborted');
        trace.end(
          { answer: text, sources: rag.sources, finishReason },
          level,
        );
        await flushAsync();
        data.close();
      },
    });

    return result.toDataStreamResponse({ data });
  } catch (err) {
    console.error('[api/chat] failed:', err);
    const message = err instanceof Error ? err.message : String(err);
    trace.end({ error: message }, 'ERROR');
    await flushAsync();
    return Response.json({ error: 'chat failed' }, { status: 500 });
  }
}
```

Key changes vs. existing code:
- Imports `startTrace`, `flushAsync`, `requireUser`.
- `Body` zod schema accepts optional `sessionId` (UUID from client).
- `userId` resolved via best-effort `requireUser()` — failures don't block the request (current chat is anon-callable).
- One trace per request, 6 spans (condense, classify, retrieve, rerank, build-prompt, generate). The 4 middle spans are opened inside `runRag` because we passed `parentTrace`.
- `onFinish` ends the generate span, sets `WARNING` + tag for aborts, awaits `flushAsync()` before closing the stream.
- Catch path ends the trace with `ERROR`, awaits flush.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: zero errors. If `requireUser` import surfaces a build issue (it pulls `next/headers`), fall back to:
```ts
import { getCurrentUser } from '@/lib/auth';
// ...
const user = await getCurrentUser();
const userId = user?.id;
```
`getCurrentUser` returns null instead of throwing.

- [ ] **Step 3: Run full vitest + verify no regressions**

```bash
npm test
```

Expected: 136 prior + 4 (Task 3) + 1 (Task 5) = **141** vitest passing. (The remaining 2 from Task 11 land later.)

- [ ] **Step 4: Stage**

```bash
git add app/api/chat/route.ts
```

---

## Task 8: Manual — Sign up Langfuse + populate env

**Files:** none — external service config + `.env.local` edit. This task isn't gated by code; the implementation works (no-op) without keys, but the smoke in Task 9 needs real keys.

- [ ] **Step 1: Sign up at https://cloud.langfuse.com**

Use any email. Create an organization and a project named `procurementgpt`.

- [ ] **Step 2: Project settings → API keys → Create new API key**

Copy both:
- `pk-lf-...` (public key)
- `sk-lf-...` (secret key)

- [ ] **Step 3: Update `.env.local`**

Replace the empty values:

```
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

- [ ] **Step 4: Restart dev server**

If `npm run dev` is running, kill and restart so it picks up the new env:

```powershell
$pids = (Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
```

Then:
```bash
npm run dev > .dev-srv.log 2>&1 &
```

Poll log for `Ready in`.

---

## Task 9: Smoke — chat trace appears in Langfuse

**Files:** none — pure verification.

- [ ] **Step 1: Send a chat message**

Open `http://localhost:3000/chat`, log in as `rgoalves@gmail.com` if not already. Send: `o que é a matriz de Kraljic?`

Wait for the streaming answer to complete.

- [ ] **Step 2: Verify the trace in Langfuse**

Open https://cloud.langfuse.com → your project → Traces. Within 30 seconds you should see one trace named `chat.turn`. Click it. Verify:
- `userId` = your Supabase UUID (`16fab8f7-a960-48b4-903d-b590e476b51b`)
- `sessionId` = the current session UUID (visible in Postgres `select id from sessions order by updated_at desc limit 1`)
- Tags include `env:production`
- 6 nested spans: `condense`, `classify`, `retrieve`, `rerank`, `build-prompt`, `generate`
- Each span has input/output captured
- Total duration matches what you saw in the browser

- [ ] **Step 3: Test the abort path**

Ask a question that produces a long answer (e.g. `Explique em detalhes as cinco forças de Porter aplicadas a uma cadeia de varejo de alimentos com pelo menos 5 exemplos`). Click the Stop button mid-stream.

In Langfuse, find the new trace. Verify `level: WARNING` and tag `aborted`.

If `finishReason` from `streamText` doesn't fire on user abort in this AI SDK v4 version (it varies by minor), the trace may end with `DEFAULT` level. Acceptable — note as known limitation. The error path (Step 4) is the more important capture.

- [ ] **Step 4: Test the error path**

In `.env.local`, temporarily corrupt `GOOGLE_API_KEY` (e.g., add a `X` at the start). Restart dev server. Send a chat message. The browser will show `chat failed` (status 500).

In Langfuse, find the failure trace. Verify `level: ERROR` and the error message in output.

Restore `GOOGLE_API_KEY`. Restart dev. Verify a normal message produces a green trace again.

- [ ] **Step 5: No commit; this is verification only**

If all three traces look right, proceed. Otherwise debug — common issues:
- No traces appearing → check `.env.local` keys aren't empty + dev was restarted.
- Traces appear but no spans → `runRag` not getting `parentTrace`; check Task 7's chat route call.
- userId always undefined → `requireUser`/`getCurrentUser` not finding the cookie session; check that the request actually has the auth cookie.

---

## Task 10: `scripts/eval/golden.json` — expand to 25 pairs

**Files:**
- Modify: `scripts/eval/golden.json`

- [ ] **Step 1: Replace the file content**

Write `scripts/eval/golden.json`:

```json
[
  { "id": "kraljic-definition", "intent": "definition", "query": "O que é a matriz de Kraljic?", "expected_titles": ["A Matriz de Kraljic"] },
  { "id": "kraljic-quadrants", "intent": "definition", "query": "Quais são os quatro quadrantes da matriz de Kraljic?", "expected_titles": ["A Matriz de Kraljic"] },
  { "id": "kraljic-application", "intent": "application", "query": "Como aplicar a matriz de Kraljic em um varejo de alimentos?", "expected_titles": ["A Matriz de Kraljic"] },
  { "id": "kraljic-comparison", "intent": "comparison", "query": "Qual a diferença entre a matriz de Kraljic e uma análise ABC?", "expected_titles": ["A Matriz de Kraljic"] },
  { "id": "kraljic-edge", "intent": "edge", "query": "A matriz de Kraljic é útil para itens de baixo volume e baixo risco?", "expected_titles": ["A Matriz de Kraljic"] },

  { "id": "strategic-sourcing-definition", "intent": "definition", "query": "What is strategic sourcing?", "expected_titles": ["Strategic Sourcing Fundamentals"] },
  { "id": "strategic-sourcing-principles", "intent": "definition", "query": "What are the core principles of strategic sourcing?", "expected_titles": ["Strategic Sourcing Fundamentals"] },
  { "id": "strategic-sourcing-application", "intent": "application", "query": "How should we implement strategic sourcing in a manufacturing firm?", "expected_titles": ["Strategic Sourcing Fundamentals"] },
  { "id": "strategic-sourcing-comparison", "intent": "comparison", "query": "How is strategic sourcing different from tactical purchasing?", "expected_titles": ["Strategic Sourcing Fundamentals"] },
  { "id": "strategic-sourcing-edge", "intent": "edge", "query": "Does strategic sourcing apply to non-strategic spend categories?", "expected_titles": ["Strategic Sourcing Fundamentals"] },

  { "id": "porter-five-forces", "intent": "definition", "query": "Explique as cinco forças de Porter", "expected_titles": ["Porter's Five Forces"] },
  { "id": "porter-application-pt", "intent": "application", "query": "Como usar as forças de Porter para avaliar um setor?", "expected_titles": ["Porter's Five Forces"] },
  { "id": "porter-en-definition", "intent": "definition", "query": "What are Porter's five forces?", "expected_titles": ["Porter's Five Forces"] },
  { "id": "porter-en-application", "intent": "application", "query": "How do I apply Porter's five forces to procurement strategy?", "expected_titles": ["Porter's Five Forces"] },
  { "id": "porter-edge", "intent": "edge", "query": "As cinco forças de Porter ainda são relevantes na economia digital?", "expected_titles": ["Porter's Five Forces"] },

  { "id": "sustentaveis-definition", "intent": "definition", "query": "O que são compras sustentáveis?", "expected_titles": ["Apostila Compras Sustentáveis"] },
  { "id": "sustentaveis-iso26000", "intent": "definition", "query": "O que diz a ISO 26000 sobre responsabilidade social?", "expected_titles": ["Apostila Compras Sustentáveis"] },
  { "id": "sustentaveis-iso20400", "intent": "comparison", "query": "Qual a diferença entre ISO 26000 e ISO 20400?", "expected_titles": ["Apostila Compras Sustentáveis"] },
  { "id": "sustentaveis-rfp", "intent": "application", "query": "Como integrar critérios de sustentabilidade em um RFP?", "expected_titles": ["Apostila Compras Sustentáveis"] },
  { "id": "sustentaveis-circular", "intent": "edge", "query": "O que são compras circulares?", "expected_titles": ["Apostila Compras Sustentáveis"] },

  { "id": "smalltalk-pt", "intent": "smalltalk", "query": "oi, tudo bem?", "expected_titles": [] },
  { "id": "smalltalk-en", "intent": "smalltalk", "query": "hi, how's it going?", "expected_titles": [] },

  { "id": "porter-vs-kraljic", "intent": "comparison", "query": "Qual a diferença entre Porter e Kraljic em compras estratégicas?", "expected_titles": ["A Matriz de Kraljic", "Porter's Five Forces"] },
  { "id": "sustentaveis-vs-strategic", "intent": "comparison", "query": "How does sustainable procurement relate to strategic sourcing?", "expected_titles": ["Apostila Compras Sustentáveis", "Strategic Sourcing Fundamentals"] },
  { "id": "kraljic-vs-sustentaveis", "intent": "comparison", "query": "Como a matriz de Kraljic se conecta com compras sustentáveis?", "expected_titles": ["A Matriz de Kraljic", "Apostila Compras Sustentáveis"] }
]
```

If Task 2's re-ingest produced a title other than `Apostila Compras Sustentáveis`, replace all 7 occurrences in the JSON with the actual title.

- [ ] **Step 2: Stage**

```bash
git add scripts/eval/golden.json
```

---

## Task 11: `scripts/eval/run.ts` — Langfuse session, batched embeds, exit code, results.json (TDD)

**Files:**
- Modify: `scripts/eval/run.ts`
- Create: `tests/scripts/eval/run.test.ts`

This is the largest single task in the plan. The TDD bar is on the exit-code logic; the Langfuse session and batched-embed wiring are exercised by the live baseline run in Task 12.

- [ ] **Step 1: Write failing tests at `tests/scripts/eval/run.test.ts`**

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_EXIT = process.exit;

let tmpDir: string;
let exitCode: number | null;

beforeEach(() => {
  vi.resetModules();
  exitCode = null;
  tmpDir = mkdtempSync(join(tmpdir(), 'eval-test-'));
  // Mirror the eval script's expected layout: scripts/eval/golden.json under cwd.
  const evalDir = join(tmpDir, 'scripts', 'eval');
  require('node:fs').mkdirSync(evalDir, { recursive: true });
  process.chdir(tmpDir);
  // @ts-expect-error — replace process.exit so we can assert
  process.exit = ((code: number) => {
    exitCode = code;
    throw new Error(`__exit_${code}`);
  }) as never;
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit = ORIGINAL_EXIT;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function writeGolden(rows: unknown[]) {
  writeFileSync(
    join(tmpDir, 'scripts/eval/golden.json'),
    JSON.stringify(rows),
  );
}

function makeChunk(articleId: string) {
  return {
    chunkId: `c-${articleId}`,
    articleId,
    content: 'foo',
    ord: 0,
    articleTitle: 'X',
    vectorRank: 1,
    ftsRank: null,
    rrfScore: 1.0,
    rerankScore: 0.9,
  };
}

describe('scripts/eval/run', () => {
  it('exits 0 when recall@5 ≥ 0.85 and writes results.json', async () => {
    // Two non-smalltalk pairs, both hit → recall = 1.0.
    writeGolden([
      { id: 'a', intent: 'definition', query: 'q1', expected_titles: ['T1'] },
      { id: 'b', intent: 'definition', query: 'q2', expected_titles: ['T2'] },
    ]);

    vi.doMock('@/lib/llm/voyage', () => ({
      embed: vi.fn().mockResolvedValue([new Array(1024).fill(0), new Array(1024).fill(0)]),
    }));
    vi.doMock('@/lib/db/supabase', () => ({
      getServerSupabase: () => ({
        from: () => ({
          select: () => ({
            in: async () => ({
              data: [
                { id: 'art-1', title: 'T1' },
                { id: 'art-2', title: 'T2' },
              ],
              error: null,
            }),
          }),
        }),
      }),
    }));
    vi.doMock('@/lib/rag', () => ({
      runRag: vi.fn().mockImplementation(async (q: string) => {
        const id = q === 'q1' ? 'art-1' : 'art-2';
        return {
          classification: { needsRetrieval: true, intent: 'definition', language: 'pt', theory: null },
          sources: [{ articleId: id, articleTitle: q.toUpperCase(), chunkId: 'c1', number: 1 }],
          system: '', user: '',
          debug: { totalMs: 10, classifyMs: 1, embedMs: 1, vectorMs: 1, ftsMs: 1, rerankMs: 1 },
        };
      }),
    }));
    vi.doMock('@/lib/observability/langfuse', () => ({
      startTrace: vi.fn().mockResolvedValue({
        span: () => ({ end: () => {} }),
        end: () => {}, setMetadata: () => {}, setTag: () => {},
      }),
      flushAsync: vi.fn().mockResolvedValue(undefined),
    }));

    let caught: Error | null = null;
    try {
      await import('@/scripts/eval/run');
      // give the top-level await time to resolve if main() is async-IIFE
      await new Promise((r) => setTimeout(r, 10));
    } catch (err) {
      caught = err as Error;
    }
    expect(exitCode).toBe(0);
    const results = JSON.parse(readFileSync(join(tmpDir, 'scripts/eval/results.json'), 'utf-8'));
    expect(results.recallAt5).toBe(1.0);
    expect(results.threshold).toBe(0.85);
  });

  it('exits 1 when recall@5 < 0.85', async () => {
    writeGolden([
      { id: 'a', intent: 'definition', query: 'q1', expected_titles: ['T1'] },
      { id: 'b', intent: 'definition', query: 'q2', expected_titles: ['T2'] },
    ]);
    vi.doMock('@/lib/llm/voyage', () => ({
      embed: vi.fn().mockResolvedValue([new Array(1024).fill(0), new Array(1024).fill(0)]),
    }));
    vi.doMock('@/lib/db/supabase', () => ({
      getServerSupabase: () => ({
        from: () => ({
          select: () => ({
            in: async () => ({
              data: [{ id: 'art-1', title: 'T1' }, { id: 'art-2', title: 'T2' }],
              error: null,
            }),
          }),
        }),
      }),
    }));
    vi.doMock('@/lib/rag', () => ({
      runRag: vi.fn().mockResolvedValue({
        classification: { needsRetrieval: true, intent: 'definition', language: 'pt', theory: null },
        sources: [{ articleId: 'wrong', articleTitle: 'X', chunkId: 'c1', number: 1 }],
        system: '', user: '',
        debug: { totalMs: 10, classifyMs: 1, embedMs: 1, vectorMs: 1, ftsMs: 1, rerankMs: 1 },
      }),
    }));
    vi.doMock('@/lib/observability/langfuse', () => ({
      startTrace: vi.fn().mockResolvedValue({
        span: () => ({ end: () => {} }),
        end: () => {}, setMetadata: () => {}, setTag: () => {},
      }),
      flushAsync: vi.fn().mockResolvedValue(undefined),
    }));

    try {
      await import('@/scripts/eval/run');
      await new Promise((r) => setTimeout(r, 10));
    } catch {
      // expected — we throw on process.exit
    }
    expect(exitCode).toBe(1);
  });
});
```

Note: this test pattern uses module mocking + `process.chdir` to make the eval script load. It's a bit fiddly because the script is a top-level main function. If the top-level `main().catch(...)` pattern proves too hard to test reliably this way, refactor `scripts/eval/run.ts` to export a `runEval()` function and have the test call that, with the IIFE shim only firing when imported as a CLI. The test code above expects the existing module-execution pattern — adjust if you refactor.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/scripts/eval/run.test.ts
```

Expected: tests fail because `results.json` doesn't get written and exit codes don't match (script doesn't have the new logic yet).

- [ ] **Step 3: Replace `scripts/eval/run.ts`**

Write the new content:

```ts
#!/usr/bin/env tsx
import { config } from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '@/lib/db/supabase';
import { runRag } from '@/lib/rag';
import { embed } from '@/lib/llm/voyage';
import { startTrace, flushAsync } from '@/lib/observability/langfuse';

const RECALL_THRESHOLD = 0.85;

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

  const commit = process.env.GITHUB_SHA?.slice(0, 7) ?? 'local';
  const sessionId = `eval-${new Date().toISOString().slice(0, 10)}-${commit}`;

  // Single batched embed call for ALL queries upfront — eliminates Voyage 3 RPM throttle.
  const queryVectors = await embed(rows.map((r) => r.query), 'query');

  const results: RowResult[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const trace = await startTrace({
      name: 'eval.pair',
      sessionId,
      input: { query: row.query, intent: row.intent },
      tags: ['env:ci', `commit:${commit}`, `intent:${row.intent}`],
    });

    const ragResult = await runRag(row.query, {
      parentTrace: trace,
      _preEmbeddedQuery: queryVectors[i],
    });

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

    trace.end({
      hit,
      rank,
      sources: ragResult.sources.slice(0, 5),
      classification: ragResult.classification,
    });

    results.push({
      id: row.id,
      intent: row.intent,
      hit,
      rank,
      smalltalkSkippedCorrectly,
      totalMs: Math.round(ragResult.debug.totalMs),
    });
  }

  await flushAsync();

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

  writeFileSync(
    resolve(process.cwd(), 'scripts/eval/results.json'),
    JSON.stringify({ results, recallAt5, mrr, smalltalkRate, meanLatency, threshold: RECALL_THRESHOLD, commit, sessionId }, null, 2),
  );

  if (recallAt5 < RECALL_THRESHOLD) {
    console.error(`FAIL: recall@5 ${recallAt5.toFixed(2)} < ${RECALL_THRESHOLD}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Key changes vs. existing eval script:
- Removed the 21s/embed throttle entirely (batched embed at the top).
- Added Langfuse session + per-pair trace.
- Wrote `scripts/eval/results.json` with all metrics.
- Exit 1 when recall@5 < 0.85; print `FAIL: ...` first.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/scripts/eval/run.test.ts
```

Expected: 2 passed.

If the import path `@/scripts/eval/run` doesn't resolve under vitest's path alias config, the simpler alternative is to refactor `scripts/eval/run.ts` to export a `runEval()` function:

```ts
export async function runEval(): Promise<void> { /* the body of main() */ }

if (require.main === module) {
  runEval().catch((err) => { console.error(err); process.exit(1); });
}
```

Then the test imports `runEval` directly. Choose whichever pattern is least friction.

- [ ] **Step 5: Run full vitest + typecheck**

```bash
npm test
npm run typecheck
```

Expected: 136 + 7 = **143 vitest** passing. Zero typecheck errors.

- [ ] **Step 6: Stage**

```bash
git add scripts/eval/run.ts tests/scripts/eval/run.test.ts
```

---

## Task 12: Baseline eval — measure recall@5 on the live 25-pair set

**Files:** none — measurement run, possibly tunes `RECALL_THRESHOLD` constant.

- [ ] **Step 1: Run the eval against the live DB**

```bash
npm run rag:eval
```

Expected: <30s runtime (one Voyage call at start; no per-pair throttle). Prints the table + the four metric lines. Writes `scripts/eval/results.json`.

- [ ] **Step 2: Read the recall@5 number**

```bash
cat scripts/eval/results.json | grep recallAt5
```

- [ ] **Step 3: If recall@5 ≥ 0.85, no change — proceed to Task 13.**

- [ ] **Step 4: If recall@5 < 0.85, decide:**

Option A — **lower the threshold** to `baseline - 0.02` (round to nearest 0.05). Edit `scripts/eval/run.ts`:
```ts
const RECALL_THRESHOLD = 0.80; // baseline 0.82 measured 2026-05-03; targeting +5% as quality improves
```
Update spec §1, §5.5, §11 risk row, §9 critério #6 to match.

Option B — **investigate which pairs failed**, fix the corpus or retrieval, re-run. Common reasons: re-ingested apostila has different chunk granularity than expected; comparison queries (`porter-vs-kraljic`) may not retrieve from BOTH expected articles in top 5.

Option B is preferred if there's a clear retrieval bug. Option A is acceptable if the failures are reasonable (e.g. comparison queries are inherently harder).

- [ ] **Step 5: Verify the threshold passes after any change**

```bash
npm run rag:eval
echo "exit: $?"
```

Expected: exit 0.

- [ ] **Step 6: Stage any code changes**

If `RECALL_THRESHOLD` changed:
```bash
git add scripts/eval/run.ts
```

If golden pairs changed (option B path may add or remove pairs):
```bash
git add scripts/eval/golden.json
```

---

## Task 13: `.github/workflows/ci.yml`

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow file**

Write `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - run: npm ci

      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install Python deps
        if: hashFiles('scripts/requirements.txt') != ''
        run: pip install -r scripts/requirements.txt

      - name: Typecheck
        run: npm run typecheck

      - name: Vitest
        run: npm test

      - name: Pytest
        if: hashFiles('scripts/tests/**/*.py') != ''
        run: pytest scripts/tests

      - name: RAG eval
        env:
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
          GEMINI_MODEL: ${{ secrets.GEMINI_MODEL }}
          VOYAGE_API_KEY: ${{ secrets.VOYAGE_API_KEY }}
          VOYAGE_MODEL: ${{ secrets.VOYAGE_MODEL }}
          COHERE_API_KEY: ${{ secrets.COHERE_API_KEY }}
          COHERE_RERANK_MODEL: ${{ secrets.COHERE_RERANK_MODEL }}
          NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
          NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          LANGFUSE_PUBLIC_KEY: ${{ secrets.LANGFUSE_PUBLIC_KEY }}
          LANGFUSE_SECRET_KEY: ${{ secrets.LANGFUSE_SECRET_KEY }}
          LANGFUSE_BASE_URL: https://cloud.langfuse.com
          GITHUB_SHA: ${{ github.sha }}
        run: npm run rag:eval

      - name: Upload eval results artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: rag-eval-results
          path: scripts/eval/results.json

      - name: PR comment with eval results
        if: github.event_name == 'pull_request' && always() && hashFiles('scripts/eval/results.json') != ''
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          {
            echo "### RAG Eval"
            jq -r '"recall@5: \(.recallAt5 | tostring) (threshold \(.threshold | tostring))"' scripts/eval/results.json
            echo ""
            echo "MRR: $(jq -r '.mrr' scripts/eval/results.json)"
            echo "smalltalk-skip: $(jq -r '.smalltalkRate' scripts/eval/results.json)"
            echo "mean latency: $(jq -r '.meanLatency' scripts/eval/results.json) ms"
            echo ""
            echo "<details><summary>per-pair</summary>"
            echo ""
            jq -r '.results[] | "- `\(.id)` (\(.intent)) — \(.hit) rank=\(.rank // "—") latency=\(.totalMs)ms"' scripts/eval/results.json
            echo "</details>"
          } > /tmp/comment.md
          gh pr comment ${{ github.event.pull_request.number }} -F /tmp/comment.md
```

- [ ] **Step 2: Stage**

```bash
git add .github/workflows/ci.yml
```

---

## Task 14: Manual — populate GitHub Actions secrets

**Files:** none — repo settings.

- [ ] **Step 1: Set all secrets via `gh secret set`**

For each variable in `.env.local`, set the matching secret. Use:

```bash
gh secret set GOOGLE_API_KEY -b "$GOOGLE_API_KEY"
gh secret set GEMINI_MODEL -b "$GEMINI_MODEL"
gh secret set VOYAGE_API_KEY -b "$VOYAGE_API_KEY"
gh secret set VOYAGE_MODEL -b "$VOYAGE_MODEL"
gh secret set COHERE_API_KEY -b "$COHERE_API_KEY"
gh secret set COHERE_RERANK_MODEL -b "$COHERE_RERANK_MODEL"
gh secret set NEXT_PUBLIC_SUPABASE_URL -b "$NEXT_PUBLIC_SUPABASE_URL"
gh secret set NEXT_PUBLIC_SUPABASE_ANON_KEY -b "$NEXT_PUBLIC_SUPABASE_ANON_KEY"
gh secret set SUPABASE_SERVICE_ROLE_KEY -b "$SUPABASE_SERVICE_ROLE_KEY"
gh secret set LANGFUSE_PUBLIC_KEY -b "$LANGFUSE_PUBLIC_KEY"
gh secret set LANGFUSE_SECRET_KEY -b "$LANGFUSE_SECRET_KEY"
```

(Source `.env.local` first via `set -a; . .env.local; set +a` in bash, OR copy the values into a `.env` file and use `gh secret set -f .env.local` to bulk-set if that flag is supported.)

- [ ] **Step 2: Verify secrets are set**

```bash
gh secret list
```

Expected: all 11 secrets visible (no values shown).

---

## Task 15: Push branch and verify CI green

**Files:** none — verification.

- [ ] **Step 1: Commit all staged changes (controller does this per task as it goes; final commit happens here if any are still staged)**

```bash
git status
```

Verify clean working tree (all task changes committed).

- [ ] **Step 2: Push the branch**

```bash
git push -u origin main
```

Or if working on a feature branch, push that and open a PR:
```bash
gh pr create --title "Sub-projeto 7: Langfuse + eval framework + CI gate" --body "Closes milestone 1. See docs/superpowers/specs/2026-05-03-langfuse-eval-design.md"
```

- [ ] **Step 3: Watch the workflow**

```bash
gh run watch
```

Expected: typecheck → vitest (143 passing) → pytest (23 passing) → rag:eval (recall@5 ≥ 0.85, exit 0). Total runtime ~3-5 min.

- [ ] **Step 4: If on PR, verify the bot commented**

```bash
gh pr view --comments | tail -30
```

Expected: a comment with the recall@5 line, MRR, smalltalk-skip rate, mean latency, and the per-pair details collapsed.

---

## Task 16: Verify CI red on a deliberately broken commit

**Files:** none — verification.

- [ ] **Step 1: Create a temp branch with a deliberate eval-breaking change**

```bash
git checkout -b verify-ci-red
```

Edit `lib/rag/reranker.ts`. Replace the `try { ... } catch` body with a no-op return that always reverses the order:

```ts
export async function rerank(
  query: string,
  chunks: RetrievedChunk[],
  topN: number,
): Promise<RetrievedChunk[]> {
  return chunks.slice().reverse().slice(0, topN);
}
```

This should tank recall@5 because the most-relevant-by-RRF chunks now sit at the bottom.

- [ ] **Step 2: Commit + push**

```bash
git add lib/rag/reranker.ts
git commit -m "verify: deliberately break reranker to confirm CI red"
git push -u origin verify-ci-red
gh pr create --title "VERIFY-CI-RED — DO NOT MERGE" --body "Verifying the eval gate fails as expected"
```

- [ ] **Step 3: Watch the workflow fail**

```bash
gh run watch
```

Expected: `RAG eval` step fails with `FAIL: recall@5 ... < 0.85`. Workflow exit non-zero. PR shows red X.

- [ ] **Step 4: Confirm the PR comment shows the failure**

```bash
gh pr view --comments | tail -40
```

Expected: comment includes the new (lower) recall@5 number and the per-pair table showing many `miss`es.

- [ ] **Step 5: Close the verification PR + delete branch (do not merge)**

```bash
gh pr close --delete-branch
git checkout main
git branch -D verify-ci-red
```

---

## Task 17: Final smoke + restore

**Files:** none — sanity check.

- [ ] **Step 1: Make sure main has no leftover broken code**

```bash
git diff main..HEAD
```

Expected: nothing, or the expected sub-projeto 7 changes (depending on whether the executor merged via PR or pushed straight to main).

- [ ] **Step 2: Run all checks one last time on main**

```bash
npm test
npm run typecheck
scripts/.venv/Scripts/pytest.exe scripts/tests/ -q
npm run rag:eval
```

Expected: 143 vitest, zero typecheck, 23 pytest, recall@5 ≥ threshold + exit 0.

- [ ] **Step 3: Verify dev server still works end-to-end**

```bash
npm run dev > .dev-srv.log 2>&1 &
```

Wait for `Ready in`. Hit `http://localhost:3000/api/health`. Expected: 200.

Send a chat message via `/chat`. Verify a trace appears in Langfuse.

Stop dev:
```powershell
$pids = (Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
```

---

## Task 18: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add row to status table**

In CLAUDE.md, after the `6c` row in the status table, add:

```markdown
| 7 | `langfuse-eval-complete` | Langfuse instrumentation em `/api/chat` (Edge): trace por turno com 6 spans aninhados (condense, classify, retrieve, rerank, build-prompt, generate), userId = Supabase UUID, sessionId = sessions.id, flush em onFinish/error/abort. Eval expandido para 25 pares (5 ângulos × 4 artigos + 2 smalltalk + 3 comparison) com batched embed (1 chamada Voyage). CI workflow GitHub Actions roda typecheck + vitest + pytest + rag:eval em PR + push para main, falha se `recall@5 < 0.85`. Eval traces tagged `env:ci` agrupados em sessão por commit. |
```

- [ ] **Step 2: Update Pendente line**

Replace:
```
**Pendente:** sub-projeto 7 (Langfuse + full eval framework + golden CI gate).
```

With:
```
**Milestone 1 closed.** Próximo: definir milestone 2 com base em uso real (traces em Langfuse).
```

- [ ] **Step 3: Update test count**

Replace the `Test count atual:` line with:

```markdown
**Test count atual:** 143 vitest, 23 pytest, typecheck zero erros. CI gate: `recall@5 ≥ 0.85` em PR + push main.
```

- [ ] **Step 4: Add observability paths to "Estrutura de pastas"**

Under `/lib`, after `/rag`, insert:

```
  /observability                        (NEW: sub-projeto 7)
    types.ts                            (Trace, Span, TraceLevel)
    langfuse.ts                         (startTrace, flushAsync, no-op fallback when keys absent)
```

Under `.github/`:

```
/.github/workflows/ci.yml               (typecheck + vitest + pytest + rag:eval, gates PR + main)
```

- [ ] **Step 5: Add princípio de observabilidade**

Append to the "Princípios não-negociáveis" list:

```markdown
7. **Observabilidade obrigatória** — `/api/chat` abre uma Langfuse trace por turno; cada estágio do RAG é um span. Sem isto, retrieval e prompt iteram às cegas.
```

- [ ] **Step 6: Add gotchas to "O que evitar"**

Append:

```markdown
- Chamar `runRag` em código cliente diretamente (sempre via `/api/chat` para garantir trace + auth)
- Importar `langfuse` top-level em rotas Edge — usar `await import('langfuse')` dentro de `startTrace` (a wrapper já faz isso). Top-level pode quebrar Edge cold-start
- Esquecer `await flushAsync()` no `onFinish`/catch do `streamText` — Edge runtime mata a função quando a response termina, perdendo traces silenciosamente
- Pular o batching de embeds no eval — 25 chamadas seriais à Voyage levaria 8.75 min vs <30s batched
- Mudar `RECALL_THRESHOLD` sem atualizar a spec + CLAUDE.md (o número precisa ser auditável depois)
```

- [ ] **Step 7: Stage**

```bash
git add CLAUDE.md
```

---

## Task 19: Tag `langfuse-eval-complete` + close milestone 1

**Files:** none — git tag.

- [ ] **Step 1: Verify all sub-projeto 7 commits are merged to main**

```bash
git log --oneline main..HEAD
```

Expected: empty (all changes on main).

- [ ] **Step 2: Tag**

```bash
git tag -a langfuse-eval-complete -m "Sub-projeto 7 (Langfuse + Eval Framework + CI Gate) complete — chat.turn trace with 6 RAG sub-spans, eval expanded 10→25 pairs with batched embedding, GitHub Actions CI gates PR + main on recall@5 ≥ 0.85. Milestone 1 closed: 143 vitest + 23 pytest, typecheck zero, recall@5 ≥ threshold on live corpus."
```

- [ ] **Step 3: Push the tag**

```bash
git push origin langfuse-eval-complete
```

- [ ] **Step 4: Verify**

```bash
git tag -l 'langfuse-eval-complete'
```

Expected: `langfuse-eval-complete` listed.

Milestone 1 is closed.

---

## Self-Review Notes

**Spec coverage check:**

| Spec section | Covered by |
|---|---|
| §2 — `lib/observability/langfuse.ts` no-op fallback | Task 3 (Steps 4 + tests cover both no-op cases) |
| §2 — `/api/chat` instrumentation w/ 6 spans + flush in onFinish/error/abort | Task 7 |
| §2 — `runRag` accepts `parentTrace` | Task 5 |
| §2 — Eval batches embeds, exits 1 below threshold, writes results.json | Task 11 |
| §2 — 25 golden pairs, 5 angles × 4 + smalltalk + comparison | Task 10 |
| §2 — `.github/workflows/ci.yml` on PR + main, artifact + PR comment | Task 13 |
| §2 — `langfuse` runtime dep | Task 1 |
| §2 — 7 new vitest tests | Tasks 3 (4) + 5 (1) + 11 (2) = 7 |
| §2 — CLAUDE.md update | Task 18 |
| §5.4 — Client passes `sessionId` in body | Task 6 |
| §5.6 — `retriever` accepts `preEmbedded` | Task 4 |
| §6 — Full enumeration of 25 pairs | Task 10 (full JSON literal) |
| §7 — No DB schema changes | Confirmed; no migration tasks |
| §8.1 — All 7 unit tests | Tasks 3, 5, 11 |
| §8.2 — Manual smoke (Langfuse signup, chat trace, abort, error) | Tasks 8, 9 |
| §9 critério #2 (real chat turn → trace with 6 spans) | Task 9 Step 2 |
| §9 critério #3 (error → ERROR level) | Task 9 Step 4 |
| §9 critério #4 (abort → WARNING + tag) | Task 9 Step 3 |
| §9 critério #6 (exit code on threshold) | Task 11 (TDD) + Task 12 (live verification) |
| §9 critério #7 (CI runs in correct order, fails fast, artifact, PR comment) | Tasks 13, 15, 16 |
| §9 critério #8 (eval Langfuse session + tags) | Task 11 (impl) + Task 15 (verify in Langfuse after a CI run) |
| §9 critério #11 (tag + milestone) | Task 19 |
| §11 — Threshold tunable per baseline measurement | Task 12 explicitly handles this |
| §12 — Re-ingest apostila prerequisite | Task 2 |

No gaps.

**Placeholder scan:** No "TBD" / "implement later" / "similar to N". Every step has actual code or actual command. The only intentional ambiguity is Task 12 (threshold may shift to baseline−0.02 if the live recall is below 0.85) — that's a measurement-driven decision, not a placeholder.

**Type consistency:**
- `Trace`, `Span`, `TraceLevel` types defined in Task 3 (`lib/observability/types.ts`). Used in Task 5 (`runRag` opts), Task 7 (route imports `TraceLevel`). Match.
- `RunRagOpts` defined in Task 5 with `parentTrace?: Trace` and `_preEmbeddedQuery?: number[]`. Used in Task 7 (chat route) and Task 11 (eval). Match.
- `RetrieveOptions.preEmbedded?: number[]` defined in Task 4. Used by `runRag` in Task 5 (`retrieve(query, { preEmbedded: opts._preEmbeddedQuery })`). Match.
- `startTrace(opts).span(name, input)` returns `Span`; `Span.end(output, level)`. Same shape used in Task 5 (`runRag`), Task 7 (chat), Task 11 (eval).
- `Body` zod schema in Task 7 adds `sessionId: z.string().uuid().optional()`. Task 6's `useChat({ body: { sessionId: session.id } })` sends a UUID (sessions.id from `useChatSessionsRemote`). Match.
- `Body` zod schema enforces messages structure compatible with the existing chat body. Match.

**Test count:** 4 (Task 3) + 1 (Task 5) + 2 (Task 11) = **7**. Brings 136 → 143. Matches spec.

**Dispatch suggestion to controller:**
- Tasks 1, 2, 4, 6, 8, 9, 12, 14, 15, 16, 17, 18, 19: controller inline (deps, manual UI, manual config, smoke, tag — no creative reasoning).
- Tasks 3, 5, 7, 11: subagent (sonnet) — TDD with non-trivial code (langfuse wrapper, runRag span plumbing, full Edge route rewrite, eval script with mocked DB).
- Tasks 10, 13: controller inline (literal JSON / YAML).
