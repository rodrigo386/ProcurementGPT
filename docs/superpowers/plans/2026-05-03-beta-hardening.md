# Beta Hardening Implementation Plan (Sub-projeto 8)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden ProcurementGPT enough to safely open a closed beta — Postgres-based per-user rate limiting on `/api/chat`, friendly toast UX for failures, Cohere relevance threshold to suppress low-confidence answers, dynamic `env:` tag in Langfuse traces, and a manual smoke checklist.

**Architecture:** Each concern owns one file: rate limit lives behind a Postgres `security definer` function called via a thin TS wrapper; toast lives in `sonner` mounted in the root layout and triggered from the `useChat` lifecycle in `ChatSession`; threshold lives in the reranker, prompt-builder is unchanged; environment tag is read from `APP_ENV` at request time. No new vendor (Postgres handles rate limit; `sonner` is a tiny client-only lib).

**Tech Stack:** Next.js 14 App Router (Node runtime on `/api/chat`), Supabase (Postgres + Auth + RLS), Vercel AI SDK v4, `sonner` 1.x, vitest, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-05-03-beta-hardening-design.md`

---

## File Structure

**New files:**
- `supabase/migrations/00000000000007_rate_limits.sql` — table + index + `check_rate_limit` RPC
- `lib/rate-limit.ts` — TS wrapper around the RPC (single export `checkChatRateLimit`)
- `tests/lib/rate-limit.test.ts` — vitest unit tests for the wrapper
- `components/ui/sonner.tsx` — shadcn-style Toaster wrapper
- `components/chat/ChatErrorBoundary.tsx` — class component error boundary, ~30 lines
- `tests/components/chat/ChatSession.test.tsx` — renders + toast on 429 / 500
- `docs/product/beta-smoke-test.md` — manual checklist

**Modified files:**
- `app/api/chat/route.ts` — auth required; rate limit; dynamic `env:` tag
- `tests/api/chat.test.ts` — extend to cover 401 (no user) and 429 (rate limit hit)
- `lib/rag/reranker.ts` — `MIN_RELEVANCE = 0.10` filter
- `tests/lib/rag/reranker.test.ts` — new file (none today) covering threshold; OR colocate in existing test
- `lib/rag/index.ts` — `rerank` span gains `top1Score`, sets `low-confidence` tag when empty
- `app/layout.tsx` — mounts `<Toaster />` inside `ThemeProvider`
- `components/chat/ChatSession.tsx` — `onResponse` + `onError` callbacks fire toasts
- `components/chat/ChatRoot.tsx` — wraps `<ChatSession/>` with `<ChatErrorBoundary/>`
- `package.json` — adds `sonner`
- `.env.local.example` — adds `APP_ENV=local`
- `CLAUDE.md` — documents new gotchas + sub-projeto 8 row

---

## Conventions

- **Test runner:** `npm test` (vitest run, all suites). Single file: `npm test -- tests/lib/rate-limit.test.ts`. Use `vi.doMock` + `vi.resetModules()` pattern (see `tests/api/chat.test.ts` for canonical example) when mocking `@/lib/...` modules.
- **DB client:** server code uses `supabaseServer()` from `@/lib/db/supabase-server` (returns a cookie-aware client; `auth.uid()` works inside RPCs). The function name is `supabaseServer`, not `getServerSupabase`.
- **Auth:** `getCurrentUser()` returns `User | null`; `requireUser()` throws `NotAuthenticated` (a custom Error subclass).
- **Migrations:** sequential 14-digit prefix; next number is `00000000000007`.
- **Commits:** atomic per task. Format: `<type>(<scope>): <subject>` with the standard `Co-Authored-By` footer used in recent commits. Each commit message ends with a literal HEREDOC body. **Do not skip hooks.**
- **Edge note:** `/api/chat` runtime is `nodejs` (set in `app/api/chat/route.ts:16`). Do not change.
- **Tag at end:** after Task 13 passes, the final commit is annotated/tagged `beta-hardening-complete`.

---

## Task 1: Migration 0007 — `rate_limit_events` + RPC

**Files:**
- Create: `supabase/migrations/00000000000007_rate_limits.sql`

- [ ] **Step 1: Write the migration file**

Write to `supabase/migrations/00000000000007_rate_limits.sql`:

```sql
-- Sub-projeto 8: per-user sliding-window rate limit for /api/chat.
-- Backed by an INSERT-counted events table; lookups via a security-definer RPC
-- so the table itself stays inaccessible to clients.

create table rate_limit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  created_at timestamptz not null default now()
);

create index rate_limit_events_lookup
  on rate_limit_events(user_id, endpoint, created_at desc);

alter table rate_limit_events enable row level security;
-- No policies are intentionally added: RLS-on with no policies => zero
-- direct access for any role. Only the security-definer RPC below reads/writes.

create or replace function check_rate_limit(
  p_endpoint text,
  p_per_min int,
  p_per_hour int
)
returns table(allowed boolean, retry_after_secs int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_min_count int;
  v_hour_count int;
begin
  if v_user is null then
    return query select false, 60;
    return;
  end if;

  select count(*) into v_min_count from rate_limit_events
    where user_id = v_user
      and endpoint = p_endpoint
      and created_at > now() - interval '1 minute';

  select count(*) into v_hour_count from rate_limit_events
    where user_id = v_user
      and endpoint = p_endpoint
      and created_at > now() - interval '1 hour';

  if v_min_count >= p_per_min then
    return query select false, 60;
    return;
  end if;

  if v_hour_count >= p_per_hour then
    return query select false, 3600;
    return;
  end if;

  insert into rate_limit_events(user_id, endpoint) values (v_user, p_endpoint);

  -- Probabilistic cleanup (~1% of calls) keeps the table small without pg_cron.
  if random() < 0.01 then
    delete from rate_limit_events where created_at < now() - interval '2 hour';
  end if;

  return query select true, 0;
end$$;

revoke all on function check_rate_limit(text, int, int) from public;
grant execute on function check_rate_limit(text, int, int) to authenticated;
```

- [ ] **Step 2: Apply the migration to the linked Supabase project**

Run: `npm run db:migrate`
Expected: success message; the new migration appears in `supabase migration list`.
If `npm run db:migrate` fails for environment reasons (no linked project, etc.), apply via Supabase dashboard SQL editor by pasting the file contents.

- [ ] **Step 3: Smoke-test the RPC manually (optional but recommended)**

In Supabase SQL editor (logged in as your admin user via the dashboard):

```sql
select * from check_rate_limit('chat', 10, 60);
-- Expected: (true, 0)
select count(*) from rate_limit_events where endpoint = 'chat';
-- Expected: 1 (your insert)
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00000000000007_rate_limits.sql
git commit -m "$(cat <<'EOF'
feat(db): add rate_limit_events + check_rate_limit RPC (sub-projeto 8)

Per-user sliding window (1 min + 1 hour) backed by a Postgres counter table
and security-definer RPC. Probabilistic cleanup keeps the table bounded
without pg_cron.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `lib/rate-limit.ts` wrapper (TDD)

**Files:**
- Create: `lib/rate-limit.ts`
- Test: `tests/lib/rate-limit.test.ts`

- [ ] **Step 1: Write the failing test**

Write to `tests/lib/rate-limit.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

function mockSupabaseRpc(impl: (name: string, args: unknown) => unknown) {
  const rpc = vi.fn(impl);
  vi.doMock('@/lib/db/supabase-server', () => ({
    supabaseServer: () => ({ rpc }),
  }));
  return rpc;
}

describe('checkChatRateLimit', () => {
  it('returns { allowed: true } when RPC reports allowed', async () => {
    mockSupabaseRpc(() => ({ data: [{ allowed: true, retry_after_secs: 0 }], error: null }));
    const { checkChatRateLimit } = await import('@/lib/rate-limit');
    await expect(checkChatRateLimit()).resolves.toEqual({ allowed: true });
  });

  it('returns { allowed: false, retryAfterSecs } when RPC reports blocked', async () => {
    mockSupabaseRpc(() => ({ data: [{ allowed: false, retry_after_secs: 3600 }], error: null }));
    const { checkChatRateLimit } = await import('@/lib/rate-limit');
    await expect(checkChatRateLimit()).resolves.toEqual({ allowed: false, retryAfterSecs: 3600 });
  });

  it('fails open when the RPC errors out', async () => {
    mockSupabaseRpc(() => ({ data: null, error: { message: 'boom' } }));
    const { checkChatRateLimit } = await import('@/lib/rate-limit');
    await expect(checkChatRateLimit()).resolves.toEqual({ allowed: true });
  });

  it('fails open when the RPC returns an empty array', async () => {
    mockSupabaseRpc(() => ({ data: [], error: null }));
    const { checkChatRateLimit } = await import('@/lib/rate-limit');
    await expect(checkChatRateLimit()).resolves.toEqual({ allowed: true });
  });

  it('passes the documented limits to the RPC', async () => {
    const rpc = mockSupabaseRpc(() => ({ data: [{ allowed: true, retry_after_secs: 0 }], error: null }));
    const { checkChatRateLimit, RATE_LIMIT_PER_MIN, RATE_LIMIT_PER_HOUR } = await import('@/lib/rate-limit');
    await checkChatRateLimit();
    expect(rpc).toHaveBeenCalledWith('check_rate_limit', {
      p_endpoint: 'chat',
      p_per_min: RATE_LIMIT_PER_MIN,
      p_per_hour: RATE_LIMIT_PER_HOUR,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/lib/rate-limit.test.ts`
Expected: FAIL with `Cannot find module '@/lib/rate-limit'` or similar.

- [ ] **Step 3: Write the wrapper**

Write to `lib/rate-limit.ts`:

```ts
import { supabaseServer } from '@/lib/db/supabase-server';

export const RATE_LIMIT_PER_MIN = 10;
export const RATE_LIMIT_PER_HOUR = 60;

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSecs: number };

type RpcRow = { allowed: boolean; retry_after_secs: number };

export async function checkChatRateLimit(): Promise<RateLimitResult> {
  const sb = supabaseServer();
  const { data, error } = await sb.rpc('check_rate_limit', {
    p_endpoint: 'chat',
    p_per_min: RATE_LIMIT_PER_MIN,
    p_per_hour: RATE_LIMIT_PER_HOUR,
  });

  // Fail-open: if the RPC fails for any reason, do not shut down chat for all
  // users. The risk of one user occasionally bypassing the limit is much lower
  // than the risk of the product being unusable due to an RPC regression.
  if (error || !Array.isArray(data) || data.length === 0) {
    if (error) console.warn('[rate-limit] RPC failed, fail-open:', error.message);
    return { allowed: true };
  }

  const row = data[0] as RpcRow;
  if (row.allowed) return { allowed: true };
  return { allowed: false, retryAfterSecs: row.retry_after_secs };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/lib/rate-limit.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add lib/rate-limit.ts tests/lib/rate-limit.test.ts
git commit -m "$(cat <<'EOF'
feat(rate-limit): add checkChatRateLimit wrapper (sub-projeto 8)

Thin wrapper around the check_rate_limit RPC with fail-open semantics.
Limits are constants (10/min, 60/h) for the beta; future tiers will
parameterize via org once Milestone 3 lands multi-tenancy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire rate limit + auth requirement into `/api/chat`

**Files:**
- Modify: `app/api/chat/route.ts`
- Test: `tests/api/chat.test.ts`

- [ ] **Step 1: Add failing tests for 401 and 429**

Open `tests/api/chat.test.ts`. Add these two test cases at the end of the existing `describe('POST /api/chat', ...)` block (before the closing `});`):

```ts
  it('returns 401 when there is no authenticated user', async () => {
    vi.doMock('@/lib/rag/condenser', () => ({ condenseQuery: vi.fn() }));
    vi.doMock('@/lib/rag', () => ({ runRag: vi.fn() }));
    vi.doMock('ai', () => ({
      streamText: vi.fn(),
      StreamData: class {
        appendMessageAnnotation = vi.fn();
        close = vi.fn();
      },
    }));
    vi.doMock('@ai-sdk/google', () => ({
      createGoogleGenerativeAI: vi.fn(() => () => 'mock-model'),
    }));
    vi.doMock('@/lib/observability/langfuse', () => ({
      startTrace: vi.fn().mockResolvedValue(NOOP_TRACE),
      flushAsync: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/auth', () => ({ getCurrentUser: vi.fn().mockResolvedValue(null) }));
    vi.doMock('@/lib/rate-limit', () => ({ checkChatRateLimit: vi.fn() }));

    const { POST } = await import('@/app/api/chat/route');
    const res = await POST(makeReq({ messages: [{ role: 'user', content: 'oi' }] }));
    expect(res.status).toBe(401);
  });

  it('returns 429 with Retry-After when rate limit is exceeded', async () => {
    vi.doMock('@/lib/rag/condenser', () => ({ condenseQuery: vi.fn() }));
    vi.doMock('@/lib/rag', () => ({ runRag: vi.fn() }));
    vi.doMock('ai', () => ({
      streamText: vi.fn(),
      StreamData: class {
        appendMessageAnnotation = vi.fn();
        close = vi.fn();
      },
    }));
    vi.doMock('@ai-sdk/google', () => ({
      createGoogleGenerativeAI: vi.fn(() => () => 'mock-model'),
    }));
    vi.doMock('@/lib/observability/langfuse', () => ({
      startTrace: vi.fn().mockResolvedValue(NOOP_TRACE),
      flushAsync: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/auth', () => ({
      getCurrentUser: vi.fn().mockResolvedValue({ id: 'user-1' }),
    }));
    vi.doMock('@/lib/rate-limit', () => ({
      checkChatRateLimit: vi.fn().mockResolvedValue({ allowed: false, retryAfterSecs: 60 }),
    }));

    const { POST } = await import('@/app/api/chat/route');
    const res = await POST(makeReq({ messages: [{ role: 'user', content: 'oi' }] }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    const body = await res.json();
    expect(body).toEqual({ error: 'rate_limited', retry_after_secs: 60 });
  });
```

- [ ] **Step 2: Run new tests to verify they fail**

Run: `npm test -- tests/api/chat.test.ts`
Expected: 401 + 429 tests FAIL (current route always returns 200 for valid bodies).

- [ ] **Step 3: Update `app/api/chat/route.ts`**

Replace the body of `POST` (lines ~35–60 of current file). The full new function below — copy it as-is, replacing the existing `POST` and keeping the rest of the file (imports, runtime, Body schema) unchanged. Add `import { checkChatRateLimit } from '@/lib/rate-limit';` near the other imports.

```ts
import { z } from 'zod';
import { streamText, StreamData } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { requireEnv } from '@/lib/env';
import { runRag } from '@/lib/rag';
import { condenseQuery } from '@/lib/rag/condenser';
import type { ChatMessage } from '@/lib/rag/types';
import { startTrace, flushAsync } from '@/lib/observability/langfuse';
import { getCurrentUser } from '@/lib/auth';
import { checkChatRateLimit } from '@/lib/rate-limit';
import type { TraceLevel } from '@/lib/observability/types';

export const runtime = 'nodejs';

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

  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const rl = await checkChatRateLimit();
  if (!rl.allowed) {
    return Response.json(
      { error: 'rate_limited', retry_after_secs: rl.retryAfterSecs },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSecs) } },
    );
  }

  const messages: ChatMessage[] = parsed.messages;
  const env = process.env.APP_ENV ?? 'production';

  const trace = await startTrace({
    name: 'chat.turn',
    userId: user.id,
    sessionId: parsed.sessionId,
    input: { messages },
    tags: [`env:${env}`],
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
          tokens_in: usage.promptTokens,
          tokens_out: usage.completionTokens,
          finish_reason: finishReason,
          chars_out: text.length,
        });
        const aborted = finishReason === 'error';
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

Note: the previous `// Node runtime (was 'edge'…)` block-comment is intentionally dropped — sub-projeto 7's runtime decision is now in CLAUDE.md, not source. Keep the file lean.

- [ ] **Step 4: Update older `chat.test.ts` cases that didn't mock auth/rate-limit**

The pre-existing happy-path tests now hit the new gates. For each existing test in `tests/api/chat.test.ts` that posts a valid body and expects 200, add these mocks alongside the existing `vi.doMock` calls:

```ts
vi.doMock('@/lib/auth', () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: 'user-1' }),
}));
vi.doMock('@/lib/rate-limit', () => ({
  checkChatRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));
```

Re-read existing tests carefully — only modify cases that previously expected success. The 400-status cases don't reach auth/rate-limit and don't need the new mocks.

- [ ] **Step 5: Run all chat tests**

Run: `npm test -- tests/api/chat.test.ts`
Expected: all tests passing including the new 401 and 429 cases.

- [ ] **Step 6: Run full vitest + typecheck**

Run: `npm test && npm run typecheck`
Expected: zero failures, zero type errors.

- [ ] **Step 7: Commit**

```bash
git add app/api/chat/route.ts tests/api/chat.test.ts
git commit -m "$(cat <<'EOF'
feat(api/chat): require auth + apply rate limit + dynamic env tag (sub-projeto 8)

- /api/chat now returns 401 when getCurrentUser is null (defense-in-depth on
  top of middleware gating /chat).
- Pre-trace rate limit check via checkChatRateLimit; 429 + Retry-After + JSON
  body { error: 'rate_limited', retry_after_secs }.
- env:<APP_ENV> tag on the trace (defaults to 'production' when unset).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Cohere relevance threshold in reranker (TDD)

**Files:**
- Modify: `lib/rag/reranker.ts`
- Create: `tests/lib/rag/reranker.test.ts`

- [ ] **Step 1: Write the failing test**

Write to `tests/lib/rag/reranker.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { RetrievedChunk } from '@/lib/rag/types';

beforeEach(() => {
  vi.resetModules();
});

function chunk(id: string, content: string): RetrievedChunk {
  return {
    chunkId: id,
    articleId: `art-${id}`,
    articleTitle: `Title ${id}`,
    content,
    rrfScore: 0,
  };
}

describe('rerank', () => {
  it('keeps chunks with relevanceScore >= MIN_RELEVANCE', async () => {
    vi.doMock('@/lib/llm/cohere', () => ({
      rerank: vi.fn().mockResolvedValue([
        { index: 0, relevanceScore: 0.9 },
        { index: 1, relevanceScore: 0.5 },
      ]),
    }));
    const { rerank } = await import('@/lib/rag/reranker');
    const result = await rerank('q', [chunk('a', 'aaa'), chunk('b', 'bbb')], 5);
    expect(result.map((c) => c.chunkId)).toEqual(['a', 'b']);
  });

  it('filters out chunks with relevanceScore < MIN_RELEVANCE', async () => {
    vi.doMock('@/lib/llm/cohere', () => ({
      rerank: vi.fn().mockResolvedValue([
        { index: 0, relevanceScore: 0.5 },
        { index: 1, relevanceScore: 0.05 },  // below 0.10 threshold
      ]),
    }));
    const { rerank } = await import('@/lib/rag/reranker');
    const result = await rerank('q', [chunk('a', 'aaa'), chunk('b', 'bbb')], 5);
    expect(result.map((c) => c.chunkId)).toEqual(['a']);
  });

  it('returns empty array when every score is below threshold', async () => {
    vi.doMock('@/lib/llm/cohere', () => ({
      rerank: vi.fn().mockResolvedValue([
        { index: 0, relevanceScore: 0.02 },
        { index: 1, relevanceScore: 0.04 },
      ]),
    }));
    const { rerank } = await import('@/lib/rag/reranker');
    const result = await rerank('q', [chunk('a', 'aaa'), chunk('b', 'bbb')], 5);
    expect(result).toEqual([]);
  });

  it('falls back to RRF order when Cohere throws', async () => {
    vi.doMock('@/lib/llm/cohere', () => ({
      rerank: vi.fn().mockRejectedValue(new Error('cohere down')),
    }));
    const { rerank } = await import('@/lib/rag/reranker');
    const result = await rerank('q', [chunk('a', 'aaa'), chunk('b', 'bbb')], 1);
    expect(result.map((c) => c.chunkId)).toEqual(['a']);
  });

  it('returns [] when given no candidates', async () => {
    vi.doMock('@/lib/llm/cohere', () => ({ rerank: vi.fn() }));
    const { rerank } = await import('@/lib/rag/reranker');
    expect(await rerank('q', [], 5)).toEqual([]);
  });
});
```

Note: if `RetrievedChunk` type does not have `rrfScore`, drop that property from the helper. Verify against `lib/rag/types.ts` before writing the test — adjust to match actual fields.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/lib/rag/reranker.test.ts`
Expected: at least the threshold-filter and empty-output tests FAIL (current reranker returns all hits).

- [ ] **Step 3: Update `lib/rag/reranker.ts`**

Replace the file with:

```ts
import { rerank as cohereRerank } from '@/lib/llm/cohere';
import type { RetrievedChunk } from './types';

/**
 * Cohere v3 relevance scores below this are treated as noise: we drop the
 * chunk and let prompt-builder fall through to its REFUSAL_INSTRUCTION path.
 * Tuned empirically; gated by `npm run rag:eval` recall@5 >= 0.85.
 */
const MIN_RELEVANCE = 0.10;

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
    const results: RetrievedChunk[] = [];
    for (const h of hits) {
      if (h.relevanceScore < MIN_RELEVANCE) continue;
      const src = chunks[h.index];
      if (src) results.push({ ...src, rerankScore: h.relevanceScore });
    }
    return results;
  } catch (err) {
    console.warn('[rag/reranker] Cohere failed, falling back to RRF order:', err);
    return chunks.slice(0, topN);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/lib/rag/reranker.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/rag/reranker.ts tests/lib/rag/reranker.test.ts
git commit -m "$(cat <<'EOF'
feat(rag/reranker): drop chunks below MIN_RELEVANCE 0.10 (sub-projeto 8)

Cohere v3 scores below 0.10 are noise — letting them through caused the model
to hallucinate ungrounded answers. When all scores fall below threshold the
reranker returns [], and prompt-builder falls through to REFUSAL_INSTRUCTION.
Threshold gated by rag:eval recall@5 >= 0.85.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `top1Score` + `low-confidence` tag in rerank span

**Files:**
- Modify: `lib/rag/index.ts`

- [ ] **Step 1: Update `lib/rag/index.ts`**

Locate the rerank block (around lines 42–46 of the current file) and replace it with:

```ts
    const tRerankStart = performance.now();
    const rerankSpan = trace?.span('rerank', { candidates: candidates.length });
    chunks = await rerank(query, candidates, RERANK_TOP_N);
    const top1Score = chunks[0]?.rerankScore ?? null;
    rerankSpan?.end({ kept: chunks.length, top1Score });
    if (chunks.length === 0) trace?.setTag('low-confidence');
    rerankMs = performance.now() - tRerankStart;
```

The change is additive: same span name, same prior fields, new `top1Score` field plus a conditional tag on the parent trace when nothing survives the threshold.

- [ ] **Step 2: Run RAG tests**

Run: `npm test -- tests/lib/rag` (or `npm test` if no rag-specific path)
Expected: all passing.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add lib/rag/index.ts
git commit -m "$(cat <<'EOF'
feat(rag): record top1Score + low-confidence tag on rerank span (sub-projeto 8)

Lets Langfuse dashboards filter traces where the threshold dropped every
chunk, which is the clearest signal that retrieval missed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Install `sonner` and mount `<Toaster />`

**Files:**
- Create: `components/ui/sonner.tsx`
- Modify: `app/layout.tsx`
- Modify: `package.json` + `package-lock.json`

- [ ] **Step 1: Install `sonner`**

Run: `npm install sonner@^1.5.0`
Expected: package added; lockfile updated.

- [ ] **Step 2: Write `components/ui/sonner.tsx`**

```tsx
'use client';

import { Toaster as SonnerToaster } from 'sonner';
import { useTheme } from 'next-themes';

export function Toaster() {
  const { resolvedTheme } = useTheme();
  return (
    <SonnerToaster
      position="top-center"
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast: 'group toast bg-background text-foreground border-border',
        },
      }}
    />
  );
}
```

- [ ] **Step 3: Mount `<Toaster />` in `app/layout.tsx`**

Open `app/layout.tsx`. Add the import near the others:

```ts
import { Toaster } from '@/components/ui/sonner';
```

And update the `RootLayout` return so the body looks like:

```tsx
<body>
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
    {children}
    <Toaster />
  </ThemeProvider>
</body>
```

(`<Toaster />` MUST be inside `ThemeProvider` so it can read the resolved theme.)

- [ ] **Step 4: Verify type + build**

Run: `npm run typecheck && npm test`
Expected: zero type errors; tests still pass.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json components/ui/sonner.tsx app/layout.tsx
git commit -m "$(cat <<'EOF'
feat(ui): mount sonner Toaster in root layout (sub-projeto 8)

Used by ChatSession in the next commit to surface friendly errors and
rate-limit messages.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Toast on 429 / 500 in `ChatSession` (TDD)

**Files:**
- Modify: `components/chat/ChatSession.tsx`
- Create: `tests/components/chat/ChatSession.test.tsx`

- [ ] **Step 1: Write the failing test**

Write to `tests/components/chat/ChatSession.test.tsx`:

```tsx
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatSession } from '@/components/chat/ChatSession';
import type { StoredSession } from '@/lib/chat-storage';

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

const ORIGINAL_FETCH = globalThis.fetch;

function makeSession(): StoredSession {
  return { id: '11111111-1111-1111-1111-111111111111', title: 'Test', messages: [], updatedAt: 0 };
}

beforeEach(() => {
  toastError.mockReset();
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('<ChatSession/>', () => {
  it('renders the empty state when there are no messages', () => {
    render(<ChatSession session={makeSession()} onMessagesChange={() => {}} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('shows a friendly toast when /api/chat returns 429', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'rate_limited', retry_after_secs: 120 }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof fetch;

    render(<ChatSession session={makeSession()} onMessagesChange={() => {}} />);
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'oi{enter}');

    // useChat is async; flush microtasks
    await new Promise((r) => setTimeout(r, 50));

    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/Limite.*\d+\s*min/i));
  });

  it('shows a generic toast on a 500 response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'chat failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof fetch;

    render(<ChatSession session={makeSession()} onMessagesChange={() => {}} />);
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'oi{enter}');
    await new Promise((r) => setTimeout(r, 50));

    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/problema/i));
  });
});
```

Note: existing tests in this repo use the `tests/` mirror layout. Verify `vitest.config` includes `tests/` (it does — see `tests/api/...` examples).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/components/chat/ChatSession.test.tsx`
Expected: FAIL on the toast assertions (429/500 toasts not yet wired).

- [ ] **Step 3: Update `components/chat/ChatSession.tsx`**

```tsx
'use client';

import { useChat, type Message as AIMessage } from 'ai/react';
import { toast } from 'sonner';
import type { ChatMessage } from '@/lib/rag/types';
import type { StoredSession } from '@/lib/chat-storage';
import { EmptyState } from './EmptyState';
import { MessageList } from './MessageList';
import { Composer } from './Composer';

type Props = {
  session: StoredSession;
  onMessagesChange: (messages: ChatMessage[]) => void;
};

function toChatMessages(messages: AIMessage[]): ChatMessage[] {
  return messages
    .filter((m): m is AIMessage & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));
}

export function ChatSession({ session, onMessagesChange }: Props) {
  const { messages, input, setInput, handleSubmit, isLoading, stop } = useChat({
    api: '/api/chat',
    id: session.id,
    body: { sessionId: session.id },
    initialMessages: session.messages.map((m, i) => ({
      id: `${session.id}-${i}`,
      role: m.role,
      content: m.content,
    })),
    onResponse: async (res) => {
      if (res.status === 429) {
        const body = await res.clone().json().catch(() => ({}));
        const secs: number = typeof body?.retry_after_secs === 'number' ? body.retry_after_secs : 60;
        const minutes = Math.max(1, Math.ceil(secs / 60));
        toast.error(`Limite de mensagens atingido. Tente novamente em ~${minutes} min.`);
      }
    },
    onError: (err) => {
      // 429 already surfaced via onResponse — avoid double toast.
      if (err.message.includes('rate_limited') || err.message.includes('429')) return;
      toast.error('Tivemos um problema. Tente enviar novamente.');
    },
    onFinish: (assistant) => {
      const next = toChatMessages([...messages, assistant]);
      onMessagesChange(next);
    },
  });

  return (
    <>
      {messages.length === 0 ? (
        <EmptyState onPick={(text) => setInput(text)} />
      ) : (
        <MessageList
          messages={messages.map((m) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: m.content,
          }))}
          isLoading={isLoading}
        />
      )}
      <Composer
        input={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        isLoading={isLoading}
        onStop={stop}
      />
    </>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/components/chat/ChatSession.test.tsx`
Expected: 3 passing.

- [ ] **Step 5: Run full vitest + typecheck**

Run: `npm test && npm run typecheck`
Expected: zero failures, zero type errors.

- [ ] **Step 6: Commit**

```bash
git add components/chat/ChatSession.tsx tests/components/chat/ChatSession.test.tsx
git commit -m "$(cat <<'EOF'
feat(chat): friendly toasts on 429 / 500 (sub-projeto 8)

onResponse intercepts 429 to read retry_after_secs and shows a localized
message; onError handles other failures with a generic friendly text.
Skips a double-toast when the upstream error wraps a rate-limit response.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: React error boundary around `<ChatSession/>`

**Files:**
- Create: `components/chat/ChatErrorBoundary.tsx`
- Modify: `components/chat/ChatRoot.tsx`

- [ ] **Step 1: Write `ChatErrorBoundary`**

Write to `components/chat/ChatErrorBoundary.tsx`:

```tsx
'use client';

import React from 'react';

type Props = { children: React.ReactNode };
type State = { hasError: boolean };

export class ChatErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(err: Error) {
    console.error('[chat] render error:', err);
  }

  reset = () => this.setState({ hasError: false });

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full items-center justify-center p-8 text-center text-muted-foreground">
          <div>
            <p className="mb-2">Algo quebrou ao renderizar a conversa.</p>
            <button onClick={this.reset} className="underline">
              Tentar de novo
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
```

- [ ] **Step 2: Wrap `<ChatSession/>` in `ChatRoot`**

Open `components/chat/ChatRoot.tsx`. Add the import:

```ts
import { ChatErrorBoundary } from './ChatErrorBoundary';
```

In the JSX returned by `ChatRootMounted`, wrap the existing `<ChatSession ... />` with the boundary so that block becomes:

```tsx
<ChatErrorBoundary>
  <ChatSession
    key={sessionsApi.currentId}
    session={sessionsApi.current}
    onMessagesChange={sessionsApi.updateMessages}
  />
</ChatErrorBoundary>
```

The `key={sessionsApi.currentId}` remount stays — the boundary is the parent now.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 4: Smoke render test (manual)**

Run: `npm run dev` (Claude does this in background per memory `dev_server_workflow.md`).
Open `http://localhost:3000/chat`. Confirm chat still renders.

- [ ] **Step 5: Commit**

```bash
git add components/chat/ChatErrorBoundary.tsx components/chat/ChatRoot.tsx
git commit -m "$(cat <<'EOF'
feat(chat): wrap ChatSession in a render error boundary (sub-projeto 8)

Catches the rare cases where markdown rendering or a child component throws
mid-render; shows a Tentar de novo affordance instead of a white screen.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Smoke test checklist + `.env.local.example`

**Files:**
- Create: `docs/product/beta-smoke-test.md`
- Modify: `.env.local.example`

- [ ] **Step 1: Write `docs/product/beta-smoke-test.md`**

```markdown
# Beta Smoke Test — Manual Checklist

Run this checklist before sending a beta invite. Updated 2026-05-03.

## Prereqs
- [ ] Latest `main` deployed to the beta Vercel environment
- [ ] `APP_ENV=beta` configured in Vercel project env
- [ ] `LANGFUSE_*` keys present in Vercel project env
- [ ] Migration 0007 applied to production Supabase

## Auth
- [ ] `/login` email + senha login works
- [ ] `/login` Google OAuth login works
- [ ] `/admin/users` invite sends a magic link; clicking it logs the new user in
- [ ] `/forgot-password` sends a reset email; setting new password works; login with new password works

## Chat — desktop
- [ ] `/chat` loads with empty state and 4 suggestion cards
- [ ] Clicking a suggestion fills the composer
- [ ] Sending a message starts streaming inside 3 s
- [ ] Stop button cancels mid-stream
- [ ] Refreshing during streaming reloads the conversation cleanly (no broken state)
- [ ] Theme toggle: system / light / dark all render correctly
- [ ] Markdown (lists, bold, headings) renders correctly
- [ ] Sidebar: switching between sessions remounts cleanly; deleting works

## Chat — mobile
- [ ] `/chat` on a mobile viewport (DevTools or real device) shows the hamburger
- [ ] Drawer opens and closes
- [ ] Composer is reachable above the keyboard

## Failure modes
- [ ] Delete the `sb-*` cookies in DevTools mid-session, send a message → user is redirected to `/login`
- [ ] Send 11 messages within 60 s → toast "Limite de mensagens atingido…" appears; 11th message does not stream
- [ ] Ask "o que você sabe sobre origami?" → response explicitly says it has no source on the topic (no hallucinated frameworks)

## Admin
- [ ] As admin, `/admin/{users,articles,ingest}` all load
- [ ] As non-admin, `/admin` returns 404
- [ ] Ingest a small PDF; job moves through queued → parsing → chunking → embedding → done

## Observability
- [ ] Latest message appears as a `chat.turn` trace in Langfuse with tag `env:beta`
- [ ] Trace shows 6 nested spans (condense, classify, retrieve, rerank, build-prompt, generate)
- [ ] Rerank span shows `top1Score` and `kept` fields
- [ ] An origami-style query trace carries the `low-confidence` tag

If any item fails, file an issue and fix before sending invites.
```

- [ ] **Step 2: Update `.env.local.example`**

Open `.env.local.example`. After the existing block (verify against the file's current layout — append at the bottom is fine), add:

```
# Sub-projeto 8: drives env:<value> tag on Langfuse traces.
# Allowed values: local | beta | production | ci
APP_ENV=local
```

- [ ] **Step 3: Commit**

```bash
git add docs/product/beta-smoke-test.md .env.local.example
git commit -m "$(cat <<'EOF'
docs: add beta smoke checklist + APP_ENV in .env.local.example (sub-projeto 8)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: CLAUDE.md updates

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

Make three edits:

1. **Add `APP_ENV` to the env block.** In the `## Variáveis de ambiente` section, append:
   ```
   APP_ENV=local                  # sub-projeto 8 — drives env:<value> tag in Langfuse (local|beta|production|ci)
   ```

2. **Add gotchas to `## O que evitar`.** Append these bullets:
   - Mudar `MIN_RELEVANCE` em `lib/rag/reranker.ts` sem rodar `npm run rag:eval` — o threshold é gateado por `recall@5 ≥ 0.85` e qualquer mudança precisa ser auditável.
   - Acessar `rate_limit_events` direto do cliente — a tabela tem RLS sem policies por design; sempre via RPC `check_rate_limit` (security definer).
   - Esquecer de adicionar mocks de `@/lib/auth` + `@/lib/rate-limit` em testes novos de `/api/chat` — sem eles a route hoje retorna 401 antes de qualquer outro código rodar.
   - Mudar a versão de `sonner` sem confirmar que o `Toaster` continua honrando o tema do `next-themes`. Tema é resolvido em runtime via `useTheme()`.

3. **Add the sub-projeto 8 row to the Status table.** In the `## Status — sub-projetos completos` table, after the row for sub-projeto 7, add:

   ```markdown
   | 8 | `beta-hardening-complete` | Per-user rate limit em `/api/chat` (10/min, 60/h) via Postgres RPC `check_rate_limit` + tabela `rate_limit_events` (migration 0007, RLS sem policies, RPC security definer com cleanup probabilístico). Auth obrigatório em `/api/chat` (401 sem cookie). Threshold `MIN_RELEVANCE = 0.10` no reranker — chunks abaixo são descartados, prompt-builder cai no `REFUSAL_INSTRUCTION`. Tag dinâmica `env:${APP_ENV}` no trace (default `production`). Span `rerank` ganha `top1Score`; trace ganha tag `low-confidence` quando threshold zera tudo. `sonner` Toaster no root layout; `ChatSession` mostra toast amigável em 429 (lê `retry_after_secs`) e 500. `ChatErrorBoundary` envolvendo `<ChatSession/>`. Checklist manual em `docs/product/beta-smoke-test.md`. |
   ```

   Then update the "**Milestone 2 — Beta Readiness**" subsection to mark sub-projeto 8 as completed and sub-projeto 9 as the next active step.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(CLAUDE.md): record sub-projeto 8 (beta-hardening) + new gotchas

- Status row + Milestone 2 progress
- APP_ENV documented in env block
- 4 new gotchas: reranker threshold, rate_limit_events RLS, /api/chat test
  mocks, sonner+next-themes coupling

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Final verification — eval gate + tag

**Files:**
- None modified

- [ ] **Step 1: Run the full test matrix locally**

Run: `npm test && npm run typecheck`
Expected: zero failures, zero type errors.

- [ ] **Step 2: Run the eval gate**

Run: `npm run rag:eval`
Expected: `recall@5 >= 0.85` (CI gate). The threshold change in Task 4 is the riskiest part — if recall drops below 0.85, do **not** proceed.

If recall drops below 0.85:
1. Lower `MIN_RELEVANCE` in `lib/rag/reranker.ts` to 0.08, re-run.
2. If still failing, lower to 0.05, re-run.
3. If still failing, set to 0.0 (disable threshold), commit a follow-up note in the spec, and open a Milestone-3 task to tune via real beta traces.
4. Each change in this loop gets its own commit.

- [ ] **Step 3: Push and verify CI**

Run: `git push origin main` (or open a PR per project workflow — recent commits land directly on main, so push to main is the default).
Expected: GitHub Actions runs typecheck + vitest + pytest + rag:eval; all green.

- [ ] **Step 4: Apply the milestone tag**

```bash
git tag beta-hardening-complete
git push origin beta-hardening-complete
```

- [ ] **Step 5: Verify deployment env**

Confirm in Vercel dashboard that the beta environment has `APP_ENV=beta` set. (Documented in `docs/product/beta-smoke-test.md` Prereqs.)

- [ ] **Step 6: Run the smoke test manually**

Walk through `docs/product/beta-smoke-test.md`. All boxes must be checked before sending the first invite.

---

## Self-Review (post-write)

**Spec coverage:** every section of `docs/superpowers/specs/2026-05-03-beta-hardening-design.md` mapped to a task —
1. Rate limit (storage + migration + wrapper + integration) → Task 1, 2, 3
2. Error boundary + toast → Task 6, 7, 8
3. Threshold no reranker (+ span instrumentation) → Task 4, 5
4. Tag dinâmica `env:` → Task 3 (route), Task 9 (.env.local.example)
5. Smoke test → Task 9
- Critério de pronto / risks / decisões deferidas → Task 11 + Task 10 (CLAUDE.md gotchas)

**Placeholder scan:** no TBDs, no TODOs, no "implement appropriately"-style language. Every code block is complete.

**Type consistency:** wrapper exports `RATE_LIMIT_PER_MIN` and `RATE_LIMIT_PER_HOUR` (same names used in tests). Function `checkChatRateLimit` consistent. `RateLimitResult` discriminated union consistent. `MIN_RELEVANCE` consistent across reranker and tests. `top1Score` field name consistent in span and tag check.

**Gaps fixed inline:** none found.

---

## Open Questions / Deferred

- Recall@5 may move slightly with the threshold; Task 11 has the playbook.
- `Sidebar` may need a future "rate-limit indicator" widget (X/60 used today). Not in this plan — Milestone 3.
