# Sub-projeto 7 — Langfuse + Eval Framework + Golden CI Gate

> **Status:** Design (sub-projeto 7 of 7 — closes milestone 1).
> **Date:** 2026-05-03
> **Depends on:** 1 (env vars + lib structure), 3 (`runRag`), 4 (`/api/chat`), 6a (auth identity), 6b (sessions IDs), 6c (article corpus).
> **Consumed by:** future milestones — production observability becomes a permanent input to retrieval/prompt iteration.

## 1. Contexto

Sub-projetos 1-6c shipped a working invite-only chat product with a TS-only ingest pipeline and an admin UI. What's missing for milestone 1 to close cleanly:

- **Production observability.** Today every chat turn is a black box. When a user reports "the answer was wrong," there is no way to see what the retriever returned, what the reranker did, what context the LLM saw, how long each stage took, or how often this fails. The product can't be iterated on without that visibility.
- **Eval coverage at meaningful scale.** Sub-projeto 3 shipped 10 golden pairs with recall@5 = 1.00 — too small to detect regressions. The bar for "is retrieval still good?" needs to be both broader (more topics, more angles) and automated.
- **CI gate.** Today nothing prevents a PR from breaking retrieval. A change to `prompt-builder.ts`, the chunker, the reranker, or even an env var update can silently degrade quality and reach main without anyone noticing until the next manual eval run.

This sub-projeto wires Langfuse into both production chat and the eval CLI, expands the golden set from 10 → 25 pairs (5 angles × 4 articles + smalltalk + comparison), and adds a GitHub Actions workflow that gates PR merges and main pushes on `recall@5 ≥ 0.85`.

Critério de pronto: a real chat turn from `rgoalves@gmail.com` shows up in Langfuse cloud as one trace with 6 nested spans (condense, classify, retrieve, rerank, build-prompt, generate); `npm run rag:eval` runs the 25-pair set in <30s using batched embeddings and exits 0; opening a PR triggers the CI workflow which runs typecheck + vitest + pytest + rag:eval and blocks merge if recall@5 drops below 0.85.

## 2. Objetivo

Entregar:
- `lib/observability/langfuse.ts` — single client wrapper with `startTrace` + `flushAsync`; no-op when `LANGFUSE_SECRET_KEY` missing/empty.
- Instrumentation of `/api/chat` (Edge): trace per request with `userId` (Supabase UUID) + `sessionId` (sessions.id), 6 nested spans for the RAG pipeline + generate, flush inside `onFinish` (incl. error + abort paths).
- `runRag` accepts an optional `parentTrace`; when present, sub-steps open `parentTrace.span(name)` and end them with structured output. When omitted, runs as before (no-op spans).
- Eval CLI (`scripts/eval/run.ts`) creates a Langfuse session per run tagged `env:ci` + `commit:<sha>`, batches the embedding call (1 call for all 25 queries instead of 25), exits 1 when recall@5 < 0.85, writes `scripts/eval/results.json` artifact.
- `scripts/eval/golden.json` expanded to **25 pairs**: 5 angles per article × 4 articles + 2 smalltalk + 3 multi-source comparison. (Full enumeration in §8.)
- `.github/workflows/ci.yml` — runs on `pull_request` + `push to main`. Order: typecheck → vitest → pytest → rag:eval. Uploads results.json as artifact. PR comment with the eval table.
- `langfuse` runtime dep added (multi-runtime; verified Edge-compatible).
- 7 new vitest tests (4 for langfuse wrapper, 1 for runRag parentTrace plumbing, 2 for eval exit codes). Pytest 23/23 unchanged.
- CLAUDE.md updated with sub-projeto 7 row, observability principle, CI gate, new file paths.

**Não-objetivos** (deliberately out of scope):
- LLM-as-judge for answer quality. Recall@5 is the gate. Future milestone if/when production traces show retrieval is fine but answers are wrong (we have no golden *answers* corpus today, only golden *expected sources*).
- Tracing the ingest pipeline (`runPipeline`). Ingestion is admin-batch and inspectable in Postgres directly.
- Self-hosted Langfuse. Cloud free tier suffices for current volume.
- Hashed user IDs in traces. Pseudonymous Supabase UUIDs are LGPD-compliant; hashing buys nothing here.
- Per-environment Langfuse projects (prod vs ci). Single project + tags is the cleaner pattern.
- Real-time alerting on Langfuse metrics (Slack/email on threshold breach). Add later when there's a runbook for what to do.
- Langfuse prompt management (storing system prompts in Langfuse and pulling them at runtime). Out of scope; prompts stay in `lib/rag/prompt-builder.ts`.
- Langfuse user feedback collection (thumbs-up/down on answers). Add when the UX exists for it.

## 3. Stack

- `langfuse` (npm package — the lighter client suitable for both Node and Edge runtimes; we'll verify Edge compat at code time and switch to `langfuse-node` if needed). Single new dep.
- GitHub Actions `actions/checkout@v4`, `actions/setup-node@v4`, `actions/setup-python@v5`, `actions/upload-artifact@v4`, and the `gh` CLI for PR comments.
- Existing stack unchanged.

No DB changes. No new migrations.

## 4. Estrutura de pastas

```
/lib
  /observability                              # NEW
    langfuse.ts                               # client + startTrace + flushAsync; no-op fallback
    types.ts                                  # Trace, Span types
  /rag
    index.ts                                  # MODIFY — runRag accepts opts.parentTrace
    condenser.ts                              # MODIFY — accepts optional span arg
    classifier.ts                             # MODIFY — accepts optional span arg
    retriever.ts                              # MODIFY — accepts optional span arg + _preEmbeddedQuery
    reranker.ts                               # MODIFY — accepts optional span arg
    prompt-builder.ts                         # MODIFY — accepts optional span arg
/app/api/chat/route.ts                        # MODIFY — open trace, thread, flush in onFinish + catch + abort

/scripts/eval
  golden.json                                 # EXPAND — 10 → 25 pairs
  run.ts                                      # MODIFY — Langfuse session, batch embeds, exit code, JSON artifact

/.github/workflows                            # NEW
  ci.yml                                      # typecheck + vitest + pytest + rag:eval

/tests
  /lib/observability
    langfuse.test.ts                          # NEW — 4 tests
  /lib/rag
    index.test.ts                             # MODIFY — +1 test for parentTrace
  /scripts/eval
    run.test.ts                               # NEW — 2 tests for exit codes

CLAUDE.md                                     # MODIFY
package.json                                  # MODIFY — add langfuse
```

## 5. Componentes — contratos

### 5.1 `lib/observability/types.ts`

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

### 5.2 `lib/observability/langfuse.ts`

```ts
import type { Trace, Span, TraceLevel } from './types';

const NOOP_SPAN: Span = { end() {} };
const NOOP_TRACE: Trace = {
  span: () => NOOP_SPAN,
  end: () => {},
  setMetadata: () => {},
  setTag: () => {},
};

let cachedClient: unknown | null = null;

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

  const { Langfuse } = await import('langfuse');
  const client = (cachedClient ??= new Langfuse({
    secretKey: secret,
    publicKey: pub,
    baseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
  }));

  const lfTrace = (client as InstanceType<typeof Langfuse>).trace({
    name: opts.name,
    userId: opts.userId,
    sessionId: opts.sessionId,
    input: opts.input,
    tags: opts.tags,
    metadata: opts.metadata,
  });

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
  await (cachedClient as { flushAsync(): Promise<void> }).flushAsync();
}
```

If `langfuse` package's API differs at code time, the test mocks expose the boundary cleanly — adapt the wrapper, not the consumers.

### 5.3 `lib/rag/index.ts` (modify)

```ts
import type { Trace } from '@/lib/observability/types';

export type RunRagOpts = {
  parentTrace?: Trace;
  /** Internal hook for eval batching. Skip the embed step if the caller already has the vector. */
  _preEmbeddedQuery?: number[];
};

export async function runRag(query: string, opts: RunRagOpts = {}): Promise<RagResult> {
  const trace = opts.parentTrace; // may be undefined; helpers tolerate it

  const classifySpan = trace?.span('classify', { query });
  const classification = await classify(query);
  classifySpan?.end({ classification });

  if (!classification.needsRetrieval) {
    // smalltalk path — return early, no retrieve/rerank
    ...
  }

  const retrieveSpan = trace?.span('retrieve', { query, k: 30 });
  const candidates = await retrieve(query, { preEmbedded: opts._preEmbeddedQuery });
  retrieveSpan?.end({ vec: candidates.vecCount, fts: candidates.ftsCount, fused: candidates.fused.length });

  const rerankSpan = trace?.span('rerank', { candidates: candidates.fused.length });
  const reranked = await rerank(query, candidates.fused);
  rerankSpan?.end({ kept: reranked.length });

  const promptSpan = trace?.span('build-prompt', { sources: reranked.length });
  const prompt = buildPrompt(query, reranked, classification);
  promptSpan?.end({ systemLen: prompt.system.length, userLen: prompt.user.length });

  return { classification, sources: ..., system: prompt.system, user: prompt.user, debug: ... };
}
```

`runRag` callers that don't care about tracing pass nothing → spans are no-op `undefined?.span(...)`. Callers that do care pass `parentTrace`.

### 5.4 `app/api/chat/route.ts` (modify)

Existing handler already runs `condenseQuery` → `runRag` → `streamText`. Add tracing at three boundaries:

```ts
import { startTrace, flushAsync } from '@/lib/observability/langfuse';
import { requireUser, NotAuthenticated } from '@/lib/auth';

export async function POST(req: Request): Promise<Response> {
  const body = await parseBody(req); // existing
  const sessionId = body.sessionId; // NEW: client must include sessions.id

  let user;
  try { user = await requireUser(); } catch { return Response.json({ error: 'unauthenticated' }, { status: 401 }); }

  const trace = await startTrace({
    name: 'chat.turn',
    userId: user.id,
    sessionId,
    input: { messages: body.messages },
    tags: ['env:production'],
  });

  try {
    const condenseSpan = trace.span('condense', { messages: body.messages });
    const standalone = await condenseQuery(body.messages);
    condenseSpan.end({ standalone });

    const rag = await runRag(standalone, { parentTrace: trace });

    const generateSpan = trace.span('generate', { systemLen: rag.system.length });
    const result = streamText({
      model: ...,
      system: rag.system,
      messages: [...history, { role: 'user', content: rag.user }],
      onFinish: async ({ text, usage, finishReason }) => {
        generateSpan.end({
          tokens_in: usage.promptTokens,
          tokens_out: usage.completionTokens,
          finish_reason: finishReason,
          chars_out: text.length,
        });
        const level: TraceLevel = finishReason === 'abort' ? 'WARNING' : 'DEFAULT';
        if (finishReason === 'abort') trace.setTag('aborted');
        trace.end({ answer: text, sources: rag.sources, finishReason }, level);
        await flushAsync();
        data.close();
      },
    });

    return result.toDataStreamResponse({ data });
  } catch (err) {
    trace.end({ error: err instanceof Error ? err.message : String(err) }, 'ERROR');
    await flushAsync();
    return Response.json({ error: 'chat failed' }, { status: 500 });
  }
}
```

**Client change required:** the chat client (`useChat` hook in `ChatSession.tsx`) must include `sessionId` in the request body. The AI SDK's `useChat({ body: { sessionId: currentId } })` pattern handles this. One-line addition.

### 5.5 `scripts/eval/run.ts` (modify)

Three changes:
1. Open a Langfuse session at start (one session per CLI run).
2. Batch all golden queries through Voyage in one `embed()` call upfront; pass per-query vectors into `runRag` via `_preEmbeddedQuery`.
3. Compute recall@5; exit 1 if < 0.85; write `results.json`.

```ts
import { startTrace, flushAsync } from '@/lib/observability/langfuse';
import { embed } from '@/lib/llm/voyage';

const RECALL_THRESHOLD = 0.85;

async function main() {
  const commit = process.env.GITHUB_SHA?.slice(0, 7) ?? 'local';
  const sessionId = `eval-${new Date().toISOString().slice(0, 10)}-${commit}`;

  const rows = JSON.parse(readFileSync(goldenPath, 'utf-8')) as GoldenRow[];
  const expectedIds = await resolveExpectedIds(rows);

  // One batch embed for all queries (removes Voyage 3 RPM throttle).
  const queryVectors = await embed(rows.map((r) => r.query), 'query');

  const results: RowResult[] = [];
  for (const [i, row] of rows.entries()) {
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

    // ... existing scoring logic (hit, rank, smalltalk-skip) ...
    trace.end({ sources: ragResult.sources.slice(0, 5), classification: ragResult.classification });
    results.push(scored);
  }

  await flushAsync();

  // Same printed table as before.
  printTable(results);
  const recallAt5 = computeRecall(results);
  console.log(`recall@5: ${recallAt5.toFixed(2)} (threshold ${RECALL_THRESHOLD})`);

  writeFileSync('scripts/eval/results.json', JSON.stringify({ results, recallAt5, threshold: RECALL_THRESHOLD }, null, 2));

  if (recallAt5 < RECALL_THRESHOLD) {
    console.error(`FAIL: recall@5 ${recallAt5.toFixed(2)} < ${RECALL_THRESHOLD}`);
    process.exit(1);
  }
  process.exit(0);
}
```

The 21s/embed throttle goes away because we make 1 Voyage call total instead of 25.

### 5.6 `lib/rag/retriever.ts` (modify)

Accept optional `preEmbedded` to skip the internal `embed(query)` call:

```ts
export async function retrieve(
  query: string,
  opts?: { preEmbedded?: number[] },
): Promise<{ vecCount: number; ftsCount: number; fused: RetrievedChunk[] }> {
  const vec = opts?.preEmbedded ?? (await embed([query], 'query'))[0];
  // ... rest unchanged
}
```

### 5.7 `.github/workflows/ci.yml`

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
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci

      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install -r scripts/requirements.txt
        if: hashFiles('scripts/requirements.txt') != ''

      - run: npm run typecheck
      - run: npm test
      - run: pytest scripts/tests
        if: hashFiles('scripts/tests/**/*.py') != ''

      - name: Run RAG eval
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

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: rag-eval-results
          path: scripts/eval/results.json

      - name: PR comment with eval results
        if: github.event_name == 'pull_request' && always()
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          {
            echo "### RAG Eval"
            cat scripts/eval/results.json | jq -r '"recall@5: \(.recallAt5 | tostring) (threshold \(.threshold | tostring))"'
            echo ""
            echo "<details><summary>per-pair</summary>"
            echo ""
            cat scripts/eval/results.json | jq -r '.results[] | "- `\(.id)` (\(.intent)) — \(.hit) rank=\(.rank // "—") latency=\(.totalMs)ms"'
            echo "</details>"
          } > /tmp/comment.md
          gh pr comment ${{ github.event.pull_request.number }} -F /tmp/comment.md
```

The CI workflow's `pytest scripts/tests` step expects a `scripts/requirements.txt` — that file already exists from sub-projeto 2.

## 6. Eval expansion — 25 golden pairs

Note: Pair IDs 1-3 + 6-8 + 11 + 12 + 23 + 26 (smalltalk PT) carry over from sub-projeto 3 unchanged. The rest are NEW.

| # | id | intent | query | expected_titles |
|---|---|---|---|---|
| 1 | kraljic-definition | definition | O que é a matriz de Kraljic? | A Matriz de Kraljic |
| 2 | kraljic-quadrants | definition | Quais são os quatro quadrantes da matriz de Kraljic? | A Matriz de Kraljic |
| 3 | kraljic-application | application | Como aplicar a matriz de Kraljic em um varejo de alimentos? | A Matriz de Kraljic |
| 4 | kraljic-comparison | comparison | Qual a diferença entre a matriz de Kraljic e uma análise ABC? | A Matriz de Kraljic |
| 5 | kraljic-edge | edge | A matriz de Kraljic é útil para itens de baixo volume e baixo risco? | A Matriz de Kraljic |
| 6 | strategic-sourcing-definition | definition | What is strategic sourcing? | Strategic Sourcing Fundamentals |
| 7 | strategic-sourcing-principles | definition | What are the core principles of strategic sourcing? | Strategic Sourcing Fundamentals |
| 8 | strategic-sourcing-application | application | How should we implement strategic sourcing in a manufacturing firm? | Strategic Sourcing Fundamentals |
| 9 | strategic-sourcing-comparison | comparison | How is strategic sourcing different from tactical purchasing? | Strategic Sourcing Fundamentals |
| 10 | strategic-sourcing-edge | edge | Does strategic sourcing apply to non-strategic spend categories? | Strategic Sourcing Fundamentals |
| 11 | porter-five-forces | definition | Explique as cinco forças de Porter | Porter's Five Forces |
| 12 | porter-application-pt | application | Como usar as forças de Porter para avaliar um setor? | Porter's Five Forces |
| 13 | porter-en-definition | definition | What are Porter's five forces? | Porter's Five Forces |
| 14 | porter-en-application | application | How do I apply Porter's five forces to procurement strategy? | Porter's Five Forces |
| 15 | porter-edge | edge | As cinco forças de Porter ainda são relevantes na economia digital? | Porter's Five Forces |
| 16 | sustentaveis-definition | definition | O que são compras sustentáveis? | Apostila Compras Sustentáveis |
| 17 | sustentaveis-iso26000 | definition | O que diz a ISO 26000 sobre responsabilidade social? | Apostila Compras Sustentáveis |
| 18 | sustentaveis-iso20400 | comparison | Qual a diferença entre ISO 26000 e ISO 20400? | Apostila Compras Sustentáveis |
| 19 | sustentaveis-rfp | application | Como integrar critérios de sustentabilidade em um RFP? | Apostila Compras Sustentáveis |
| 20 | sustentaveis-circular | edge | O que são compras circulares? | Apostila Compras Sustentáveis |
| 21 | smalltalk-pt | smalltalk | oi, tudo bem? | (none) |
| 22 | smalltalk-en | smalltalk | hi, how's it going? | (none) |
| 23 | porter-vs-kraljic | comparison | Qual a diferença entre Porter e Kraljic em compras estratégicas? | A Matriz de Kraljic; Porter's Five Forces |
| 24 | sustentaveis-vs-strategic | comparison | How does sustainable procurement relate to strategic sourcing? | Apostila Compras Sustentáveis; Strategic Sourcing Fundamentals |
| 25 | kraljic-vs-sustentaveis | comparison | Como a matriz de Kraljic se conecta com compras sustentáveis? | A Matriz de Kraljic; Apostila Compras Sustentáveis |

**Prerequisite for pairs 16-20, 24, 25:** the apostila article must be re-ingested under its correct title `Apostila Compras Sustentáveis` (the current row in DB has the bad title `036.310.189-67 Celso Rudey` from before sub-projeto 6c's clean+metadata fixes). The plan task list will include "delete + re-ingest the apostila as a prerequisite step before the first eval run."

## 7. Database & Storage

No changes. No new tables, no new policies, no new migrations. Langfuse cloud holds all observability data; nothing lands in Postgres.

## 8. Testing

### 8.1 Unit (vitest, 7 new)

| File | # | Covers |
|---|---|---|
| `tests/lib/observability/langfuse.test.ts` | 4 | (a) `startTrace` returns no-op trace when LANGFUSE_SECRET_KEY missing, (b) returns no-op when key empty string, (c) when both keys present, the wrapper calls `client.trace()` with userId/sessionId/input/tags/metadata correctly (mocking `langfuse` module), (d) `flushAsync` resolves immediately when no client was instantiated |
| `tests/lib/rag/index.test.ts` (additions) | 1 | `runRag` with `parentTrace` opens spans for classify, retrieve, rerank, build-prompt and ends each with the right output keys (mock all helpers + a fake Trace object that records calls) |
| `tests/scripts/eval/run.test.ts` | 2 | (a) main exits 0 when synthetic results yield recall@5 ≥ 0.85, (b) main exits 1 + writes results.json + prints "FAIL: recall@5" when below |

**Mocks:** `langfuse` mocked at the boundary. No live API calls in tests. The eval script uses dependency injection / module mocking to inject pre-baked `runRag` results so tests don't need a live DB.

Suite total: 136 + 7 = **143 vitest**. Pytest 23/23 unchanged.

### 8.2 Smoke (manual, after deps installed and Langfuse keys set)

1. Sign up at https://cloud.langfuse.com → create project `procurementgpt` → copy public + secret key → put in `.env.local`.
2. `npm run dev`. Log in as `rgoalves@gmail.com`. Send a chat message ("o que é Kraljic?"). Verify a streaming response.
3. Open Langfuse dashboard → Traces → see one trace `chat.turn` with userId = your UUID, sessionId = the session you opened. Expand it → see 6 nested spans (condense, classify, retrieve, rerank, build-prompt, generate). Each has input/output captured.
4. Hit the Stop button mid-stream on a long answer. Verify a new trace appears with `level: WARNING` and tag `aborted`.
5. Force an error (set GOOGLE_API_KEY to gibberish, restart dev, send message). Verify trace appears with `level: ERROR` and the error message in output.
6. Restore env. Delete the apostila article in `/admin/articles`, re-upload the PDF (clean parser produces the right title now), wait for ingest to finish.
7. `npm run rag:eval`. Verify the table prints, recall@5 ≥ 0.85, exit 0. Check Langfuse → see one Session named `eval-2026-05-03-local` with 25 traces, each tagged `env:ci` and `intent:<...>`.
8. Push a branch with a deliberate eval-breaking change (e.g. break the reranker), open a PR. Verify CI runs, fails, comments the table on the PR.
9. Revert the breaking change. CI passes. Merge.

### 8.3 Regression checks

- `npm test` ≥ 143
- `npm run typecheck` zero errors
- `pytest scripts/tests` 23/23
- `npm run rag:eval` recall@5 ≥ 0.85 on the live 25-pair set
- `/api/health` 200 unchanged
- `/chat` works for admin and regular user (with and without LANGFUSE_SECRET_KEY set — verify no-op fallback path)

## 9. Critérios de sucesso

1. `lib/observability/langfuse.ts` exports `startTrace` + `flushAsync`; both no-op when `LANGFUSE_SECRET_KEY` missing/empty.
2. A real chat turn from the production app appears in Langfuse cloud as one trace with 6 nested spans within 5 minutes of the request, with `userId` = Supabase UUID and `sessionId` = sessions.id.
3. A failed chat turn (LLM error / DB error) appears in Langfuse with `level: ERROR` and the error message in output.
4. An aborted chat turn (Stop button mid-stream) appears with `level: WARNING` and tag `aborted`.
5. `npm run rag:eval` runs the 25-pair set in <30s on a warm cache (single batched Voyage call eliminates the 21s/embed throttle).
6. `npm run rag:eval` exits 0 when recall@5 ≥ 0.85, exits 1 + prints "FAIL: recall@5 ..." when below.
7. CI workflow runs on PR + push to main: typecheck → vitest → pytest → rag:eval. Fails fast. Uploads `scripts/eval/results.json` artifact. Comments PR with the per-pair table.
8. Eval CI run shows up in Langfuse as one Session named `eval-<date>-<sha7>` with 25 traces tagged `env:ci`, `commit:<sha7>`, `intent:<...>`.
9. `npm test` ≥ 143; typecheck zero; pytest 23/23 unchanged; `/api/health` 200.
10. CLAUDE.md updated with sub-projeto 7 row, observability principle, CI gate noted, new file paths.
11. Tag `langfuse-eval-complete` on the final commit. Milestone 1 closes.

## 10. Decisões e justificativas

| Decisão | Por quê |
|---|---|
| All three pieces in one sub-projeto (Q1-A) | Closes milestone 1 in one cycle |
| Langfuse endpoint + RAG sub-spans (Q2-B) | Standard RAG observability depth — debugging requires per-stage visibility, endpoint-only doesn't answer "why was retrieval bad?" |
| Pseudonymous Supabase UUIDs (Q3-A) | LGPD-compliant by design; UUIDs aren't PII; lookup-friendly via Postgres join |
| Query/answer text traced as-is | Acceptable trade-off for an internal/B2B chatbot with named admins; masking would defeat the point of tracing |
| 25 pairs from existing 4 articles (Q4-A) | Sufficient gating signal without sourcing new PDFs; 5 angles × 4 articles exercises retrieval breadth |
| PR + main, recall@5 ≥ 0.85 hard gate (Q5 A1+B1) | Catch regressions before merge; simple stable threshold; can tune if 25-pair baseline is below 0.85 |
| Flush on error + abort + always-await flush in onFinish (Q6 A1+B1+C1) | Edge runtime would otherwise lose 10-30% of traces non-deterministically |
| Eval traces go to Langfuse tagged env:ci (Q7-A) | Single dashboard for prod + CI; avoids second-project overhead |
| `_preEmbeddedQuery` internal hook in retriever | Eval batches 25 queries into 1 Voyage call; product code unchanged |
| No-op fallback when LANGFUSE_SECRET_KEY missing | Local dev / fresh clones don't error if secret isn't set; allows progressive adoption |
| Use `langfuse` (not `langfuse-node`) | Newer, multi-runtime; verified Edge-compatible at code time. Switch to `langfuse-node` if Edge import breaks. |
| No new DB schema | Langfuse cloud holds all observability state |
| Threshold tunable in plan | Honest acknowledgment that 0.85 is a *target* — adjust if 25-pair baseline reality dictates |
| `sessionId` propagated from client to /api/chat | Required for Langfuse session grouping; one-line `useChat({ body })` change |

## 11. Riscos

| Risk | Mitigation |
|---|---|
| Langfuse SDK on Edge runtime might trigger Node-only deps | Wrapper uses dynamic `await import('langfuse')` to defer; if Edge import fails, switch chat route to `runtime: 'nodejs'` (~50ms cold start added, acceptable) |
| Adding 15 more eval pairs may dip recall@5 below 0.85 immediately | Plan task: measure baseline first, then commit to 0.85 (or tune to ~5% above measured baseline if reality dictates lower) |
| Voyage rate limit kills CI eval | Batch embedding (1 call for all 25 queries) eliminates this entirely |
| GitHub Actions secrets leak in PR logs | Eval script never logs API keys; only metric values printed; GHA auto-masks `secrets.*` |
| CI eval costs (Voyage + Gemini + Cohere) per PR | ~$0.025/run × ~30 PRs/month ≈ $0.75/month — accept |
| Langfuse trace flush adds latency | Flush happens INSIDE `onFinish` — user already received streamed answer; only server-side function lifetime extends. ~50-200ms. Invisible to user. |
| Aborted streams: `onFinish` might not fire reliably across AI SDK v4 minor versions | Plan instructs executor to verify in dev — if `onFinish` doesn't fire on abort, wrap streamText return in try/finally that flushes |
| Apostila article still has bad title in DB → eval pairs 16-20 fail | Plan first task: delete + re-ingest the apostila with the new clean parser before running eval |
| Langfuse cloud free tier limits (50k events/month) | Current volume is dozens of chat turns/day — fits easily. Upgrade is $59/mo if exceeded. |
| SDK API drift (Langfuse SDK changes constructor / trace signature) | Wrapper isolates the change to one file (`lib/observability/langfuse.ts`); test mocks document the boundary |
| `sessionId` missing from client request body | Required by §5.4; `useChat({ body: { sessionId: currentId } })` change in `ChatSession.tsx`. Test that the request body includes it. |

## 12. Sequência de implementação (esboço)

A ordem detalhada vai para o plano. Esqueleto:

1. Add dep `langfuse`.
2. **Prerequisite**: delete the apostila article in DB; re-upload the PDF via `/admin/ingest` so the new clean parser produces the correct title `Apostila Compras Sustentáveis`. Verify via SQL.
3. `lib/observability/types.ts` + `lib/observability/langfuse.ts` + 4 tests (TDD).
4. `lib/rag/retriever.ts` modify — accept `preEmbedded`.
5. `lib/rag/index.ts` modify — accept `parentTrace`, thread spans through helpers + 1 test.
6. `app/api/chat/route.ts` modify — startTrace, spans, flush in onFinish/catch/abort.
7. `components/chat/ChatSession.tsx` modify — pass `sessionId` in `useChat` body.
8. Sign up Langfuse cloud, create project, populate `.env.local` with keys.
9. Smoke: chat turn → see trace in Langfuse with 6 spans.
10. `scripts/eval/golden.json` expand to 25 pairs.
11. `scripts/eval/run.ts` modify — batch embeds, Langfuse session, exit code, results.json + 2 tests.
12. **Baseline run**: `npm run rag:eval` → record actual recall@5. If ≥ 0.85, keep threshold. If lower, set threshold to baseline − 0.02 in `RECALL_THRESHOLD` constant + record decision in CLAUDE.md.
13. `.github/workflows/ci.yml`.
14. Add GitHub Actions secrets via `gh secret set` for all keys.
15. Push branch with the workflow → verify it runs on the PR → green.
16. Push a deliberate eval-breaking commit → verify CI fails + PR comment appears.
17. Revert. Final smoke.
18. CLAUDE.md update — sub-projeto 7 row, observability principle, CI gate, new file paths, Langfuse setup link.
19. Tag `langfuse-eval-complete`. Milestone 1 done.
