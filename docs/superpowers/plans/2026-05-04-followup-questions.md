# Follow-up Questions Implementation Plan (Sub-projeto 11)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After each assistant turn in `/api/chat`, suggest 3 short follow-up questions (chips) below the last assistant message — *deepen* mode when chunks were retrieved, *redirect* mode (reformulations toward known procurement topics) on refusal — so the user can keep exploring the knowledge base with one click.

**Architecture:** A new sequential step `suggestFollowups` runs inside the existing `streamText.onFinish` of `/api/chat`, after the main answer finished streaming and before `trace.end`. It calls Gemini Flash Lite with structured JSON output (zod-validated), pushes the result via `data.appendMessageAnnotation({ followups })`, and ends a new Langfuse span `suggest-followups`. Failures are caught and degrade silently to `{ followups: [] }`. UI: a new `FollowupChips` component is rendered by `Message.tsx` only on the last assistant message; click calls `useChat.append()` from `ChatSession.tsx`, sending the chip text as a normal user message. No schema change — followups live only in the SSE annotation, never persisted.

**Tech Stack:** Next.js 14 App Router (Node runtime on `/api/chat`), `@google/genai` Gemini Flash Lite preview with `responseMimeType: 'application/json'` + `responseSchema`, Vercel AI SDK v4 annotations (`StreamData.appendMessageAnnotation`), Langfuse spans, vitest + React Testing Library, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-05-04-followup-questions-design.md`

---

## File Structure

**New files:**
- `lib/rag/followups.ts` — `suggestFollowups()` pure function (Gemini call + zod + dedup + span + abort timeout)
- `tests/lib/rag/followups.test.ts` — vitest unit tests for the helper
- `components/chat/FollowupChips.tsx` — chip row UI (button per suggestion, a11y, theme-aware)
- `tests/components/chat/FollowupChips.test.tsx` — render + click + keyboard activation

**Modified files:**
- `lib/rag/types.ts` — add `chunks: RetrievedChunk[]` to `RagResult`
- `lib/rag/index.ts` — return `chunks` alongside existing fields in `RagResult`
- `app/api/chat/route.ts` — extend `onFinish` to call `suggestFollowups`, append annotation, skip on abort/error/short-text, set `followups:empty` tag
- `tests/api/chat.test.ts` — extend orchestration test to assert followups annotation + skip cases
- `components/chat/Message.tsx` — accept `followups?: string[]`, `isLast?: boolean`, `onPickFollowup?: (s: string) => void` props; render `<FollowupChips/>` when assistant + last + not streaming
- `tests/components/chat/Message.test.tsx` — extend with chip render gating cases
- `components/chat/MessageList.tsx` — derive `followups` from annotations, derive `isLast`, accept and forward `onPickFollowup`
- `components/chat/ChatSession.tsx` — wire `onPickFollowup` to `useChat.append({ role: 'user', content })`
- `CLAUDE.md` — sub-projeto 11 row + Milestone 2 status + gotchas

---

## Conventions

- **Test runner:** `npm test` (vitest run, all suites). Single file: `npm test -- tests/lib/rag/followups.test.ts`. Use `vi.doMock` + `vi.resetModules()` for module-level mocks (canonical pattern from `tests/lib/rag/classifier.test.ts` and `tests/api/chat.test.ts`).
- **Component tests:** require `// @vitest-environment jsdom` directive on line 1 (config defaults to `node`); use `expect(...).toBeTruthy()` / `toBeDefined()` instead of jest-dom matchers (project doesn't register the setup file). See `tests/components/chat/Message.test.tsx`.
- **Gemini wrapper:** reuse existing `getGemini()` from `@/lib/llm/gemini`; mock pattern is `vi.doMock('@/lib/llm/gemini', () => ({ getGemini: () => ({ models: { generateContent: vi.fn(...) } }) }))` exactly as in `tests/lib/rag/classifier.test.ts:9-20`.
- **Trace mock:** the canonical NOOP_TRACE shape is in `tests/api/chat.test.ts:4-11`. Reuse it locally where needed: `{ id: 'mock-trace-id', span: vi.fn(() => ({ end: vi.fn() })), end: vi.fn(), setMetadata: vi.fn(), setTag: vi.fn() }`.
- **Typecheck:** `npm run typecheck`. Run after every task that touches types or moved imports.
- **Branch:** `main` (project pattern — sub-projetos 8/9/10 went direct to main).
- **Commits:** atomic per task. Format `<type>(<scope>): <subject>` with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` footer.
- **Tag at end:** after Task 13 passes locally + CI, apply `followup-questions-complete`.

---

## Task 1: Expose `chunks` from `runRag`

The spec calls for the route to pass chunk content (not just titles) to `suggestFollowups`. Today `RagResult.sources` is `SourceRef[]` with title + ids only. Extend `RagResult` with `chunks: RetrievedChunk[]` (the rerank survivors with content) so the route has what it needs. Pure refactor; no behavior change for callers.

**Files:**
- Modify: `lib/rag/types.ts:43-49`
- Modify: `lib/rag/index.ts:55-68`
- Modify: `tests/lib/rag/index.test.ts` (existing assertions if any rely on shape)

- [ ] **Step 1: Add `chunks` to `RagResult`**

In `lib/rag/types.ts`, change:

```ts
export type RagResult = {
  classification: Classification;
  sources: SourceRef[];
  system: string;
  user: string;
  debug: RagDebug;
};
```

to:

```ts
export type RagResult = {
  classification: Classification;
  chunks: RetrievedChunk[];
  sources: SourceRef[];
  system: string;
  user: string;
  debug: RagDebug;
};
```

- [ ] **Step 2: Populate `chunks` in `runRag` return**

In `lib/rag/index.ts`, change the return block:

```ts
return {
  classification,
  sources,
  system,
  user,
  debug: { ... },
};
```

to:

```ts
return {
  classification,
  chunks,
  sources,
  system,
  user,
  debug: { ... },
};
```

- [ ] **Step 3: Run existing tests and typecheck**

Run: `npm run typecheck && npm test -- tests/lib/rag`
Expected: PASS. If any test or caller asserts the exact shape of `RagResult`, update it to include `chunks` (likely just an `expect.objectContaining(...)` or an explicit shape match in `tests/api/chat.test.ts`).

- [ ] **Step 4: Update `tests/api/chat.test.ts` runRag mock if needed**

In `tests/api/chat.test.ts:88-94`, the existing `runRagSpy.mockResolvedValue` returns an object without `chunks`. Add `chunks: []` so the shape matches the new type:

```ts
const runRagSpy = vi.fn().mockResolvedValue({
  classification: { theory: 'kraljic', intent: 'definition', language: 'pt', needsRetrieval: true },
  chunks: [],
  sources: [{ number: 1, articleId: 'a', articleTitle: 'A Matriz de Kraljic', chunkId: 'c1' }],
  system: 'SYSTEM_PROMPT',
  user: 'USER_WITH_CONTEXT',
  debug: { classifyMs: 1, embedMs: 2, vectorMs: 3, ftsMs: 4, rerankMs: 5, totalMs: 15 },
});
```

(TypeScript will only complain at compile time if a strict shape assertion is in place, but adding `chunks: []` everywhere this mock appears keeps the tests honest.)

- [ ] **Step 5: Run full vitest + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS, all 143 tests green.

- [ ] **Step 6: Commit**

```bash
git add lib/rag/types.ts lib/rag/index.ts tests/api/chat.test.ts
git commit -m "$(cat <<'EOF'
refactor(rag): expose chunks in RagResult for downstream consumers

Sub-projeto 11 needs chunk content (not just SourceRef ids) to ground
follow-up suggestions. Pure additive change; no behavior shift.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `suggestFollowups` — happy path PT (deepen mode)

Build the core helper with TDD: one test, then minimal impl. PT-BR system prompt; `chunks.length > 0` activates the *deepen* path with snippets in the user prompt.

**Files:**
- Create: `lib/rag/followups.ts`
- Create: `tests/lib/rag/followups.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/rag/followups.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi } from 'vitest';

const NOOP_SPAN = { end: vi.fn() };
const NOOP_TRACE = {
  id: 'mock-trace-id',
  span: vi.fn(() => NOOP_SPAN),
  end: vi.fn(),
  setMetadata: vi.fn(),
  setTag: vi.fn(),
};

beforeEach(() => {
  process.env.GOOGLE_API_KEY = 'test-key';
  process.env.GEMINI_MODEL = 'gemini-test';
  vi.resetModules();
  vi.useRealTimers();
});

function mockGeminiOnce(returns: { text?: string; throws?: Error }) {
  const generateContent = vi.fn().mockImplementation(async () => {
    if (returns.throws) throw returns.throws;
    return { text: returns.text ?? '' };
  });
  vi.doMock('@/lib/llm/gemini', () => ({
    getGemini: () => ({ models: { generateContent } }),
  }));
  return { generateContent };
}

const PT_CLASSIFICATION = {
  theory: 'kraljic',
  intent: 'definition' as const,
  language: 'pt' as const,
  needsRetrieval: true,
};

const SAMPLE_CHUNK = {
  chunkId: 'c1',
  articleId: 'a1',
  content: 'A matriz de Kraljic divide o portfólio em quatro quadrantes...',
  ord: 0,
  articleTitle: 'A Matriz de Kraljic',
  vectorRank: 1,
  ftsRank: 2,
  rrfScore: 0.5,
  rerankScore: 0.8,
};

describe('rag followups', () => {
  it('returns 3 deepen suggestions when chunks are present (PT)', async () => {
    const { generateContent } = mockGeminiOnce({
      text: JSON.stringify({
        followups: [
          'Como aplicar Kraljic em PMEs?',
          'Diferença entre Kraljic e Cox?',
          'Quais limitações da matriz?',
        ],
      }),
    });
    const { suggestFollowups } = await import('@/lib/rag/followups');
    const out = await suggestFollowups({
      query: 'O que é a matriz de Kraljic?',
      answer: 'É um framework de Peter Kraljic publicado em 1983...',
      chunks: [SAMPLE_CHUNK],
      classification: PT_CLASSIFICATION,
      parentTrace: NOOP_TRACE,
    });
    expect(out).toEqual([
      'Como aplicar Kraljic em PMEs?',
      'Diferença entre Kraljic e Cox?',
      'Quais limitações da matriz?',
    ]);
    expect(generateContent).toHaveBeenCalledOnce();
    const callArg = generateContent.mock.calls[0][0];
    expect(callArg.contents).toContain('Material disponível');
    expect(callArg.contents).toContain('A Matriz de Kraljic');
    expect(callArg.config.responseMimeType).toBe('application/json');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/lib/rag/followups.test.ts`
Expected: FAIL with "Cannot find module '@/lib/rag/followups'".

- [ ] **Step 3: Write minimal implementation**

Create `lib/rag/followups.ts`:

```ts
import { z } from 'zod';
import { getGemini } from '@/lib/llm/gemini';
import { requireEnv } from '@/lib/env';
import type { Classification, RetrievedChunk } from './types';
import type { Trace } from '@/lib/observability/types';

const SNIPPET_MAX = 240;
const ITEM_MAX_CHARS = 120;

const FollowupsSchema = z.object({
  followups: z.array(z.string().min(3).max(ITEM_MAX_CHARS)).min(1).max(3),
});

const SYSTEM_DEEPEN_PT = `Você é um assistente que sugere 3 perguntas curtas de follow-up para um usuário que acabou de receber uma resposta sobre teoria de procurement. As perguntas devem aprofundar o tema, ser respondíveis a partir do material abaixo, e ter no máximo 90 caracteres cada. Não inclua a pergunta original. Não use IDs, números entre colchetes, nem cite fontes. Retorne JSON com a forma { "followups": [string, string, string] }.`;

export type SuggestFollowupsInput = {
  query: string;
  answer: string;
  chunks: RetrievedChunk[];
  classification: Classification;
  parentTrace?: Trace;
};

export async function suggestFollowups(input: SuggestFollowupsInput): Promise<string[]> {
  const { query, answer, chunks, classification } = input;
  const ai = getGemini();
  const model = requireEnv('GEMINI_MODEL');

  const system = SYSTEM_DEEPEN_PT;
  const material = chunks
    .map((c) => `- ${c.articleTitle}: ${c.content.slice(0, SNIPPET_MAX)}`)
    .join('\n');
  const userBlock = [
    '## Pergunta original',
    query,
    '',
    '## Resposta dada',
    answer,
    '',
    '## Material disponível',
    material,
  ].join('\n');

  const res = await ai.models.generateContent({
    model,
    contents: `${system}\n\n${userBlock}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          followups: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 3,
          },
        },
        required: ['followups'],
      },
      maxOutputTokens: 512,
    },
  });
  const text = res.text ?? '';
  const parsed = FollowupsSchema.parse(JSON.parse(text));
  return parsed.followups;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/lib/rag/followups.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/rag/followups.ts tests/lib/rag/followups.test.ts
git commit -m "$(cat <<'EOF'
feat(rag): suggestFollowups deepen happy path (PT)

Calls Gemini Flash Lite with chunk-grounded prompt, validates JSON via
zod, returns up to 3 follow-up suggestions. PT-only for now; refusal,
EN, fail-soft, timeout, span come in subsequent tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add redirect mode (chunks empty → reformulation prompt)

When `chunks.length === 0`, the prompt switches to *redirect*: ask Gemini for reformulations toward known procurement topics, do **not** include any material section.

**Files:**
- Modify: `lib/rag/followups.ts`
- Modify: `tests/lib/rag/followups.test.ts`

- [ ] **Step 1: Write the failing test (append to file)**

Append inside the `describe('rag followups', ...)` block:

```ts
  it('returns 3 redirect suggestions when chunks is empty (PT)', async () => {
    const { generateContent } = mockGeminiOnce({
      text: JSON.stringify({
        followups: [
          'Quer ver matriz de Kraljic?',
          'Modelos de TCO te interessam?',
          'Posso explicar SRM (Cousins)?',
        ],
      }),
    });
    const { suggestFollowups } = await import('@/lib/rag/followups');
    const out = await suggestFollowups({
      query: 'O que é blockchain?',
      answer: 'Não tenho fonte na base sobre isso.',
      chunks: [],
      classification: PT_CLASSIFICATION,
      parentTrace: NOOP_TRACE,
    });
    expect(out).toHaveLength(3);
    const callArg = generateContent.mock.calls[0][0];
    expect(callArg.contents).toContain('reformulações');
    expect(callArg.contents).not.toContain('Material disponível');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/lib/rag/followups.test.ts`
Expected: FAIL — test for redirect prompt content not satisfied (likely both "reformulações" not present and/or "Material disponível" still present).

- [ ] **Step 3: Implement redirect mode**

In `lib/rag/followups.ts`, add the constant near `SYSTEM_DEEPEN_PT`:

```ts
const SYSTEM_REDIRECT_PT = `Você é um assistente que ajuda um usuário cuja pergunta não foi respondida porque a base de conhecimento não tinha material sobre o tópico. Sugira 3 reformulações ou tópicos próximos de procurement (matriz de Kraljic, TCO, modelos de Cox / Cousins / Monczka, sourcing estratégico, gestão de fornecedores, Porter, Dyer, etc.) que possam estar na base. Não prometa que a base cobre o tema; apenas sugira reformulações. No máximo 90 caracteres cada. Retorne JSON com a forma { "followups": [string, string, string] }.`;
```

Replace the body of `suggestFollowups` with mode selection:

```ts
export async function suggestFollowups(input: SuggestFollowupsInput): Promise<string[]> {
  const { query, answer, chunks, classification } = input;
  const ai = getGemini();
  const model = requireEnv('GEMINI_MODEL');

  const mode: 'deepen' | 'redirect' = chunks.length > 0 ? 'deepen' : 'redirect';
  const system = mode === 'deepen' ? SYSTEM_DEEPEN_PT : SYSTEM_REDIRECT_PT;

  let userBlock: string;
  if (mode === 'deepen') {
    const material = chunks
      .map((c) => `- ${c.articleTitle}: ${c.content.slice(0, SNIPPET_MAX)}`)
      .join('\n');
    userBlock = [
      '## Pergunta original',
      query,
      '',
      '## Resposta dada',
      answer,
      '',
      '## Material disponível',
      material,
    ].join('\n');
  } else {
    userBlock = ['## Pergunta original (não respondida)', query].join('\n');
  }

  const res = await ai.models.generateContent({
    model,
    contents: `${system}\n\n${userBlock}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          followups: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
        },
        required: ['followups'],
      },
      maxOutputTokens: 512,
    },
  });
  const text = res.text ?? '';
  const parsed = FollowupsSchema.parse(JSON.parse(text));
  return parsed.followups;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/lib/rag/followups.test.ts && npm run typecheck`
Expected: PASS (both deepen and redirect tests).

- [ ] **Step 5: Commit**

```bash
git add lib/rag/followups.ts tests/lib/rag/followups.test.ts
git commit -m "$(cat <<'EOF'
feat(rag): suggestFollowups redirect mode for refusal path

When chunks is empty, switch to a reformulation prompt that nudges the
user toward procurement topics likely present in the base. No material
section in the prompt — model is instructed not to promise coverage.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: EN language support

When `classification.language === 'en'`, swap to English system prompts. Same structure, same schema.

**Files:**
- Modify: `lib/rag/followups.ts`
- Modify: `tests/lib/rag/followups.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the `describe('rag followups', ...)` block:

```ts
  it('uses EN system prompt when classification.language is en', async () => {
    const { generateContent } = mockGeminiOnce({
      text: JSON.stringify({
        followups: [
          'How does Kraljic differ from Cox?',
          'How to apply it in food retail?',
          'What are the matrix limitations?',
        ],
      }),
    });
    const { suggestFollowups } = await import('@/lib/rag/followups');
    await suggestFollowups({
      query: 'What is the Kraljic matrix?',
      answer: 'It is a framework by Peter Kraljic from 1983...',
      chunks: [SAMPLE_CHUNK],
      classification: { ...PT_CLASSIFICATION, language: 'en' },
      parentTrace: NOOP_TRACE,
    });
    const contents = generateContent.mock.calls[0][0].contents as string;
    expect(contents).toMatch(/follow-up/i);
    expect(contents).toContain('## Original question');
    expect(contents).not.toContain('Pergunta original');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/lib/rag/followups.test.ts`
Expected: FAIL — test asserts EN section labels.

- [ ] **Step 3: Implement EN support**

In `lib/rag/followups.ts`, add EN system prompts and an `i18n` helper for section labels:

```ts
const SYSTEM_DEEPEN_EN = `You are an assistant suggesting 3 short follow-up questions for a user who just received an answer about procurement theory. The questions should deepen the topic, be answerable from the material below, and be at most 90 characters each. Do not include the original question. Do not use IDs, bracketed numbers, or source citations. Return JSON shaped { "followups": [string, string, string] }.`;

const SYSTEM_REDIRECT_EN = `You are an assistant helping a user whose question was not answered because the knowledge base had no material on the topic. Suggest 3 reformulations or adjacent procurement topics (Kraljic matrix, TCO, Cox / Cousins / Monczka, strategic sourcing, supplier management, Porter, Dyer, etc.) that may exist in the base. Do not promise that the base covers the topic; only suggest reformulations. At most 90 characters each. Return JSON shaped { "followups": [string, string, string] }.`;

const LABELS = {
  pt: {
    origQ: '## Pergunta original',
    given: '## Resposta dada',
    material: '## Material disponível',
    refusalQ: '## Pergunta original (não respondida)',
  },
  en: {
    origQ: '## Original question',
    given: '## Answer given',
    material: '## Available material',
    refusalQ: '## Original question (unanswered)',
  },
} as const;
```

Update the body of `suggestFollowups` to pick prompts/labels by language:

```ts
const lang = classification.language;
const mode: 'deepen' | 'redirect' = chunks.length > 0 ? 'deepen' : 'redirect';
const system =
  mode === 'deepen'
    ? lang === 'en'
      ? SYSTEM_DEEPEN_EN
      : SYSTEM_DEEPEN_PT
    : lang === 'en'
      ? SYSTEM_REDIRECT_EN
      : SYSTEM_REDIRECT_PT;
const L = LABELS[lang];

let userBlock: string;
if (mode === 'deepen') {
  const material = chunks
    .map((c) => `- ${c.articleTitle}: ${c.content.slice(0, SNIPPET_MAX)}`)
    .join('\n');
  userBlock = [L.origQ, query, '', L.given, answer, '', L.material, material].join('\n');
} else {
  userBlock = [L.refusalQ, query].join('\n');
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- tests/lib/rag/followups.test.ts && npm run typecheck`
Expected: PASS — all 3 tests (deepen PT, redirect PT, deepen EN) green.

- [ ] **Step 5: Commit**

```bash
git add lib/rag/followups.ts tests/lib/rag/followups.test.ts
git commit -m "$(cat <<'EOF'
feat(rag): suggestFollowups EN system prompts and labels

Swap prompt and section labels based on classification.language. Same
schema, same structure — the model just speaks the user's language.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Fail-soft + dedup + query-echo filter

All paths that should return `[]`: Gemini throws, JSON parse fails, schema validation fails, post-filter (dedup, query echo) leaves nothing. Three test cases in one task — they all assert the same fail-soft behavior.

**Files:**
- Modify: `lib/rag/followups.ts`
- Modify: `tests/lib/rag/followups.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('rag followups', ...)` block:

```ts
  it('returns [] when Gemini throws', async () => {
    mockGeminiOnce({ throws: new Error('boom') });
    const { suggestFollowups } = await import('@/lib/rag/followups');
    const out = await suggestFollowups({
      query: 'q',
      answer: 'a',
      chunks: [SAMPLE_CHUNK],
      classification: PT_CLASSIFICATION,
      parentTrace: NOOP_TRACE,
    });
    expect(out).toEqual([]);
  });

  it('returns [] when JSON is malformed', async () => {
    mockGeminiOnce({ text: 'not json {' });
    const { suggestFollowups } = await import('@/lib/rag/followups');
    const out = await suggestFollowups({
      query: 'q',
      answer: 'a',
      chunks: [SAMPLE_CHUNK],
      classification: PT_CLASSIFICATION,
      parentTrace: NOOP_TRACE,
    });
    expect(out).toEqual([]);
  });

  it('returns [] when schema rejects (item too long)', async () => {
    mockGeminiOnce({
      text: JSON.stringify({
        followups: ['ok', 'x'.repeat(200), 'fine'],
      }),
    });
    const { suggestFollowups } = await import('@/lib/rag/followups');
    const out = await suggestFollowups({
      query: 'q',
      answer: 'a',
      chunks: [SAMPLE_CHUNK],
      classification: PT_CLASSIFICATION,
      parentTrace: NOOP_TRACE,
    });
    expect(out).toEqual([]);
  });

  it('dedupes case-insensitively and removes echo of original query', async () => {
    mockGeminiOnce({
      text: JSON.stringify({
        followups: [
          'O que é a matriz de Kraljic?', // echo of query
          'Como aplicar Kraljic em PMEs?',
          'COMO APLICAR KRALJIC EM PMES?', // duplicate (case)
        ],
      }),
    });
    const { suggestFollowups } = await import('@/lib/rag/followups');
    const out = await suggestFollowups({
      query: 'O que é a matriz de Kraljic?',
      answer: 'É um framework...',
      chunks: [SAMPLE_CHUNK],
      classification: PT_CLASSIFICATION,
      parentTrace: NOOP_TRACE,
    });
    expect(out).toEqual(['Como aplicar Kraljic em PMEs?']);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/lib/rag/followups.test.ts`
Expected: FAIL — current impl rethrows on Gemini error / JSON malformed / schema error; no dedup/echo filter.

- [ ] **Step 3: Wrap call in try/catch and add post-filter**

In `lib/rag/followups.ts`, replace the body of `suggestFollowups` with a try/catch that returns `[]` on any error, and add a post-filter helper:

```ts
function postProcess(items: string[], query: string): string[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const queryNorm = norm(query);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = norm(trimmed);
    if (key === queryNorm) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export async function suggestFollowups(input: SuggestFollowupsInput): Promise<string[]> {
  try {
    const { query, answer, chunks, classification } = input;
    const ai = getGemini();
    const model = requireEnv('GEMINI_MODEL');

    const lang = classification.language;
    const mode: 'deepen' | 'redirect' = chunks.length > 0 ? 'deepen' : 'redirect';
    const system =
      mode === 'deepen'
        ? lang === 'en' ? SYSTEM_DEEPEN_EN : SYSTEM_DEEPEN_PT
        : lang === 'en' ? SYSTEM_REDIRECT_EN : SYSTEM_REDIRECT_PT;
    const L = LABELS[lang];

    let userBlock: string;
    if (mode === 'deepen') {
      const material = chunks
        .map((c) => `- ${c.articleTitle}: ${c.content.slice(0, SNIPPET_MAX)}`)
        .join('\n');
      userBlock = [L.origQ, query, '', L.given, answer, '', L.material, material].join('\n');
    } else {
      userBlock = [L.refusalQ, query].join('\n');
    }

    const res = await ai.models.generateContent({
      model,
      contents: `${system}\n\n${userBlock}`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            followups: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
          },
          required: ['followups'],
        },
        maxOutputTokens: 512,
      },
    });
    const text = res.text ?? '';
    const parsed = FollowupsSchema.parse(JSON.parse(text));
    return postProcess(parsed.followups, query);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[rag/followups] returning [] due to error:', message);
    return [];
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- tests/lib/rag/followups.test.ts && npm run typecheck`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/rag/followups.ts tests/lib/rag/followups.test.ts
git commit -m "$(cat <<'EOF'
feat(rag): fail-soft, dedup, and query-echo filter for followups

Wraps the Gemini call in try/catch returning [] on any failure (network,
JSON parse, zod schema). Adds case-insensitive dedup and drops items
that echo the original query.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: AbortController 3s timeout

Hard cap on the Gemini call. Test with vitest fake timers.

**Files:**
- Modify: `lib/rag/followups.ts`
- Modify: `tests/lib/rag/followups.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the `describe('rag followups', ...)` block:

```ts
  it('aborts after 3s and returns []', async () => {
    vi.useFakeTimers();
    let abortReceived = false;
    vi.doMock('@/lib/llm/gemini', () => ({
      getGemini: () => ({
        models: {
          generateContent: vi.fn().mockImplementation(async (arg: { config?: { abortSignal?: AbortSignal } }) => {
            const signal = arg.config?.abortSignal;
            return new Promise((_, reject) => {
              signal?.addEventListener('abort', () => {
                abortReceived = true;
                reject(new Error('aborted'));
              });
            });
          }),
        },
      }),
    }));
    const { suggestFollowups } = await import('@/lib/rag/followups');
    const promise = suggestFollowups({
      query: 'q',
      answer: 'a',
      chunks: [SAMPLE_CHUNK],
      classification: PT_CLASSIFICATION,
      parentTrace: NOOP_TRACE,
    });
    await vi.advanceTimersByTimeAsync(3100);
    const out = await promise;
    expect(out).toEqual([]);
    expect(abortReceived).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/lib/rag/followups.test.ts`
Expected: FAIL — test hangs / no abort signal currently passed.

- [ ] **Step 3: Add timeout with AbortController**

In `lib/rag/followups.ts`, add at top of file (with other constants):

```ts
const TIMEOUT_MS = 3_000;
```

Inside `suggestFollowups` (within the `try`), wire the controller into the Gemini config:

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
try {
  const res = await ai.models.generateContent({
    model,
    contents: `${system}\n\n${userBlock}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          followups: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
        },
        required: ['followups'],
      },
      maxOutputTokens: 512,
      abortSignal: controller.signal,
    },
  });
  const text = res.text ?? '';
  const parsed = FollowupsSchema.parse(JSON.parse(text));
  return postProcess(parsed.followups, query);
} finally {
  clearTimeout(timer);
}
```

(The outer try/catch added in Task 5 still catches the abort error and returns `[]`.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- tests/lib/rag/followups.test.ts && npm run typecheck`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/rag/followups.ts tests/lib/rag/followups.test.ts
git commit -m "$(cat <<'EOF'
feat(rag): 3s AbortController timeout on followups Gemini call

Hard cap so a stuck Gemini call doesn't keep the SSE stream open. Aborts
fall through to the existing fail-soft try/catch and return [].

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Langfuse span `suggest-followups`

Wrap the call in a span aligned with `parentTrace`. Span input includes mode + chunkCount + queryLen; output includes count + latencyMs (success) or error (warning level).

**Files:**
- Modify: `lib/rag/followups.ts`
- Modify: `tests/lib/rag/followups.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the `describe('rag followups', ...)` block:

```ts
  it('opens a parentTrace.span("suggest-followups") and ends it on success', async () => {
    mockGeminiOnce({
      text: JSON.stringify({ followups: ['a?', 'b?', 'c?'] }),
    });
    const spanEnd = vi.fn();
    const trace = {
      id: 't1',
      span: vi.fn(() => ({ end: spanEnd })),
      end: vi.fn(),
      setMetadata: vi.fn(),
      setTag: vi.fn(),
    };
    const { suggestFollowups } = await import('@/lib/rag/followups');
    const out = await suggestFollowups({
      query: 'q',
      answer: 'a',
      chunks: [SAMPLE_CHUNK],
      classification: PT_CLASSIFICATION,
      parentTrace: trace,
    });
    expect(out).toEqual(['a?', 'b?', 'c?']);
    expect(trace.span).toHaveBeenCalledWith(
      'suggest-followups',
      expect.objectContaining({ mode: 'deepen', chunkCount: 1 }),
    );
    expect(spanEnd).toHaveBeenCalledOnce();
    const endArg = spanEnd.mock.calls[0][0];
    expect(endArg).toMatchObject({ count: 3 });
    expect(typeof endArg.latencyMs).toBe('number');
  });

  it('ends span with WARNING level on failure', async () => {
    mockGeminiOnce({ throws: new Error('boom') });
    const spanEnd = vi.fn();
    const trace = {
      id: 't1',
      span: vi.fn(() => ({ end: spanEnd })),
      end: vi.fn(),
      setMetadata: vi.fn(),
      setTag: vi.fn(),
    };
    const { suggestFollowups } = await import('@/lib/rag/followups');
    await suggestFollowups({
      query: 'q',
      answer: 'a',
      chunks: [SAMPLE_CHUNK],
      classification: PT_CLASSIFICATION,
      parentTrace: trace,
    });
    expect(spanEnd).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }), 'WARNING');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/lib/rag/followups.test.ts`
Expected: FAIL — span never opened, span.end never called.

- [ ] **Step 3: Wire the span**

In `lib/rag/followups.ts`, restructure `suggestFollowups` to open the span at the top and end it in both branches:

```ts
export async function suggestFollowups(input: SuggestFollowupsInput): Promise<string[]> {
  const { query, answer, chunks, classification, parentTrace } = input;
  const mode: 'deepen' | 'redirect' = chunks.length > 0 ? 'deepen' : 'redirect';
  const span = parentTrace?.span('suggest-followups', {
    mode,
    chunkCount: chunks.length,
    queryLen: query.length,
  });
  const startedAt = performance.now();

  try {
    const ai = getGemini();
    const model = requireEnv('GEMINI_MODEL');

    const lang = classification.language;
    const system =
      mode === 'deepen'
        ? lang === 'en' ? SYSTEM_DEEPEN_EN : SYSTEM_DEEPEN_PT
        : lang === 'en' ? SYSTEM_REDIRECT_EN : SYSTEM_REDIRECT_PT;
    const L = LABELS[lang];

    let userBlock: string;
    if (mode === 'deepen') {
      const material = chunks
        .map((c) => `- ${c.articleTitle}: ${c.content.slice(0, SNIPPET_MAX)}`)
        .join('\n');
      userBlock = [L.origQ, query, '', L.given, answer, '', L.material, material].join('\n');
    } else {
      userBlock = [L.refusalQ, query].join('\n');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await ai.models.generateContent({
        model,
        contents: `${system}\n\n${userBlock}`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              followups: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
            },
            required: ['followups'],
          },
          maxOutputTokens: 512,
          abortSignal: controller.signal,
        },
      });
      const text = res.text ?? '';
      const parsed = FollowupsSchema.parse(JSON.parse(text));
      const items = postProcess(parsed.followups, query);
      span?.end({ count: items.length, latencyMs: Math.round(performance.now() - startedAt) });
      return items;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[rag/followups] returning [] due to error:', message);
    span?.end({ error: message, latencyMs: Math.round(performance.now() - startedAt) }, 'WARNING');
    return [];
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- tests/lib/rag/followups.test.ts && npm run typecheck`
Expected: PASS — all 10 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/rag/followups.ts tests/lib/rag/followups.test.ts
git commit -m "$(cat <<'EOF'
feat(rag): langfuse span for suggest-followups

Span opens with mode/chunkCount/queryLen, ends with count/latencyMs on
success or {error,latencyMs} + WARNING level on failure. Aligned with
the chat.turn parent trace.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire `suggestFollowups` into `/api/chat` `onFinish`

Inside the existing `streamText.onFinish`, after `generateSpan.end`, call `suggestFollowups`, append annotation, set `followups:empty` tag when empty, and skip the call entirely on abort/error/short-text.

**Files:**
- Modify: `app/api/chat/route.ts:99-115`
- Modify: `tests/api/chat.test.ts`

- [ ] **Step 1: Write the failing tests (extend existing `tests/api/chat.test.ts`)**

Add a new `describe` block at the bottom of `tests/api/chat.test.ts`:

```ts
describe('POST /api/chat — followups annotation', () => {
  it('appends followups annotation in onFinish (deepen path)', async () => {
    vi.doMock('@/lib/auth', () => ({ getCurrentUser: vi.fn().mockResolvedValue({ id: 'user-123' }) }));
    vi.doMock('@/lib/rate-limit', () => ({
      checkChatRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    }));
    const traceTags: string[] = [];
    const traceMock = {
      id: 'trace-1',
      span: vi.fn(() => ({ end: vi.fn() })),
      end: vi.fn(),
      setMetadata: vi.fn(),
      setTag: vi.fn((t: string) => traceTags.push(t)),
    };
    vi.doMock('@/lib/observability/langfuse', () => ({
      startTrace: vi.fn().mockResolvedValue(traceMock),
      flushAsync: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/rag/condenser', () => ({ condenseQuery: vi.fn().mockResolvedValue('q') }));
    vi.doMock('@/lib/rag', () => ({
      runRag: vi.fn().mockResolvedValue({
        classification: { theory: null, intent: 'definition', language: 'pt', needsRetrieval: true },
        chunks: [{
          chunkId: 'c1', articleId: 'a1', content: 'conteudo', ord: 0, articleTitle: 'T',
          vectorRank: 1, ftsRank: 1, rrfScore: 0.5, rerankScore: 0.8,
        }],
        sources: [{ number: 1, articleId: 'a1', articleTitle: 'T', chunkId: 'c1' }],
        system: 'S', user: 'U',
        debug: { classifyMs: 0, embedMs: 0, vectorMs: 0, ftsMs: 0, rerankMs: 0, totalMs: 0 },
      }),
    }));
    const suggestSpy = vi.fn().mockResolvedValue(['Q1?', 'Q2?', 'Q3?']);
    vi.doMock('@/lib/rag/followups', () => ({ suggestFollowups: suggestSpy }));

    const onFinishCapture: { fn?: (arg: { text: string; usage: { promptTokens: number; completionTokens: number }; finishReason: string }) => Promise<void> } = {};
    const annotationSpy = vi.fn();
    const closeSpy = vi.fn();
    vi.doMock('ai', () => ({
      streamText: vi.fn((cfg: { onFinish?: (a: unknown) => Promise<void> }) => {
        onFinishCapture.fn = cfg.onFinish as typeof onFinishCapture.fn;
        return { toDataStreamResponse: vi.fn(() => new Response('ok', { status: 200 })) };
      }),
      StreamData: class {
        appendMessageAnnotation = annotationSpy;
        close = closeSpy;
      },
    }));
    vi.doMock('@ai-sdk/google', () => ({
      createGoogleGenerativeAI: vi.fn(() => () => 'm'),
    }));

    const { POST } = await import('@/app/api/chat/route');
    await POST(makeReq({ messages: [{ role: 'user', content: 'oi' }] }));
    await onFinishCapture.fn!({ text: 'uma resposta longa o suficiente', usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'stop' });

    expect(suggestSpy).toHaveBeenCalledOnce();
    const followupsCall = annotationSpy.mock.calls.find((c) => 'followups' in (c[0] as object));
    expect(followupsCall?.[0]).toEqual({ followups: ['Q1?', 'Q2?', 'Q3?'] });
    expect(traceTags).not.toContain('followups:empty');
  });

  it('appends empty array and tags followups:empty when suggestFollowups returns []', async () => {
    vi.doMock('@/lib/auth', () => ({ getCurrentUser: vi.fn().mockResolvedValue({ id: 'u' }) }));
    vi.doMock('@/lib/rate-limit', () => ({ checkChatRateLimit: vi.fn().mockResolvedValue({ allowed: true }) }));
    const traceTags: string[] = [];
    vi.doMock('@/lib/observability/langfuse', () => ({
      startTrace: vi.fn().mockResolvedValue({
        id: 't', span: vi.fn(() => ({ end: vi.fn() })), end: vi.fn(), setMetadata: vi.fn(),
        setTag: vi.fn((t: string) => traceTags.push(t)),
      }),
      flushAsync: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/rag/condenser', () => ({ condenseQuery: vi.fn().mockResolvedValue('q') }));
    vi.doMock('@/lib/rag', () => ({
      runRag: vi.fn().mockResolvedValue({
        classification: { theory: null, intent: 'definition', language: 'pt', needsRetrieval: true },
        chunks: [], sources: [], system: '', user: '',
        debug: { classifyMs: 0, embedMs: 0, vectorMs: 0, ftsMs: 0, rerankMs: 0, totalMs: 0 },
      }),
    }));
    vi.doMock('@/lib/rag/followups', () => ({ suggestFollowups: vi.fn().mockResolvedValue([]) }));

    const onFinishCapture: { fn?: (a: unknown) => Promise<void> } = {};
    const annotationSpy = vi.fn();
    vi.doMock('ai', () => ({
      streamText: vi.fn((cfg: { onFinish?: (a: unknown) => Promise<void> }) => {
        onFinishCapture.fn = cfg.onFinish;
        return { toDataStreamResponse: vi.fn(() => new Response('ok', { status: 200 })) };
      }),
      StreamData: class { appendMessageAnnotation = annotationSpy; close = vi.fn(); },
    }));
    vi.doMock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: vi.fn(() => () => 'm') }));

    const { POST } = await import('@/app/api/chat/route');
    await POST(makeReq({ messages: [{ role: 'user', content: 'oi' }] }));
    await onFinishCapture.fn!({ text: 'uma resposta longa o suficiente', usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'stop' });

    const fc = annotationSpy.mock.calls.find((c) => 'followups' in (c[0] as object));
    expect(fc?.[0]).toEqual({ followups: [] });
    expect(traceTags).toContain('followups:empty');
  });

  it('skips suggestFollowups when finishReason is not stop', async () => {
    vi.doMock('@/lib/auth', () => ({ getCurrentUser: vi.fn().mockResolvedValue({ id: 'u' }) }));
    vi.doMock('@/lib/rate-limit', () => ({ checkChatRateLimit: vi.fn().mockResolvedValue({ allowed: true }) }));
    vi.doMock('@/lib/observability/langfuse', () => ({
      startTrace: vi.fn().mockResolvedValue({
        id: 't', span: vi.fn(() => ({ end: vi.fn() })), end: vi.fn(), setMetadata: vi.fn(), setTag: vi.fn(),
      }),
      flushAsync: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/rag/condenser', () => ({ condenseQuery: vi.fn().mockResolvedValue('q') }));
    vi.doMock('@/lib/rag', () => ({
      runRag: vi.fn().mockResolvedValue({
        classification: { theory: null, intent: 'definition', language: 'pt', needsRetrieval: true },
        chunks: [], sources: [], system: '', user: '',
        debug: { classifyMs: 0, embedMs: 0, vectorMs: 0, ftsMs: 0, rerankMs: 0, totalMs: 0 },
      }),
    }));
    const suggestSpy = vi.fn();
    vi.doMock('@/lib/rag/followups', () => ({ suggestFollowups: suggestSpy }));

    const onFinishCapture: { fn?: (a: unknown) => Promise<void> } = {};
    vi.doMock('ai', () => ({
      streamText: vi.fn((cfg: { onFinish?: (a: unknown) => Promise<void> }) => {
        onFinishCapture.fn = cfg.onFinish;
        return { toDataStreamResponse: vi.fn(() => new Response('ok', { status: 200 })) };
      }),
      StreamData: class { appendMessageAnnotation = vi.fn(); close = vi.fn(); },
    }));
    vi.doMock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: vi.fn(() => () => 'm') }));

    const { POST } = await import('@/app/api/chat/route');
    await POST(makeReq({ messages: [{ role: 'user', content: 'oi' }] }));
    await onFinishCapture.fn!({ text: 'qualquer', usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'error' });

    expect(suggestSpy).not.toHaveBeenCalled();
  });

  it('skips suggestFollowups when text is shorter than 20 chars', async () => {
    vi.doMock('@/lib/auth', () => ({ getCurrentUser: vi.fn().mockResolvedValue({ id: 'u' }) }));
    vi.doMock('@/lib/rate-limit', () => ({ checkChatRateLimit: vi.fn().mockResolvedValue({ allowed: true }) }));
    vi.doMock('@/lib/observability/langfuse', () => ({
      startTrace: vi.fn().mockResolvedValue({
        id: 't', span: vi.fn(() => ({ end: vi.fn() })), end: vi.fn(), setMetadata: vi.fn(), setTag: vi.fn(),
      }),
      flushAsync: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/rag/condenser', () => ({ condenseQuery: vi.fn().mockResolvedValue('q') }));
    vi.doMock('@/lib/rag', () => ({
      runRag: vi.fn().mockResolvedValue({
        classification: { theory: null, intent: 'definition', language: 'pt', needsRetrieval: true },
        chunks: [], sources: [], system: '', user: '',
        debug: { classifyMs: 0, embedMs: 0, vectorMs: 0, ftsMs: 0, rerankMs: 0, totalMs: 0 },
      }),
    }));
    const suggestSpy = vi.fn();
    vi.doMock('@/lib/rag/followups', () => ({ suggestFollowups: suggestSpy }));

    const onFinishCapture: { fn?: (a: unknown) => Promise<void> } = {};
    vi.doMock('ai', () => ({
      streamText: vi.fn((cfg: { onFinish?: (a: unknown) => Promise<void> }) => {
        onFinishCapture.fn = cfg.onFinish;
        return { toDataStreamResponse: vi.fn(() => new Response('ok', { status: 200 })) };
      }),
      StreamData: class { appendMessageAnnotation = vi.fn(); close = vi.fn(); },
    }));
    vi.doMock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: vi.fn(() => () => 'm') }));

    const { POST } = await import('@/app/api/chat/route');
    await POST(makeReq({ messages: [{ role: 'user', content: 'oi' }] }));
    await onFinishCapture.fn!({ text: 'oi', usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'stop' });

    expect(suggestSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/api/chat.test.ts`
Expected: FAIL — route does not call `suggestFollowups` yet.

- [ ] **Step 3: Wire the call into the route**

In `app/api/chat/route.ts`, add to the imports near the top:

```ts
import { suggestFollowups } from '@/lib/rag/followups';
```

Replace the `onFinish` body (currently lines 99-115) with:

```ts
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

  const shouldSuggest = !aborted && finishReason === 'stop' && text.length >= 20;
  if (shouldSuggest) {
    const followups = await suggestFollowups({
      query: standalone,
      answer: text,
      chunks: rag.chunks,
      classification: rag.classification,
      parentTrace: trace,
    });
    data.appendMessageAnnotation({ followups });
    if (followups.length === 0) trace.setTag('followups:empty');
  }

  trace.end(
    { answer: text, sources: rag.sources, finishReason },
    level,
  );
  await flushAsync();
  data.close();
},
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- tests/api/chat.test.ts && npm run typecheck`
Expected: PASS — all chat tests green (existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add app/api/chat/route.ts tests/api/chat.test.ts
git commit -m "$(cat <<'EOF'
feat(api/chat): emit followups annotation in onFinish

Calls suggestFollowups after generate completes, appends the result as
a second SSE annotation, tags trace 'followups:empty' when array is
empty. Skips when stream aborted/errored or main response is too short.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `FollowupChips` UI component

Stateless presentational component. 1-3 buttons in a flex-wrap row. Click and Enter/Space activate `onPick`.

**Files:**
- Create: `components/chat/FollowupChips.tsx`
- Create: `tests/components/chat/FollowupChips.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/components/chat/FollowupChips.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FollowupChips } from '@/components/chat/FollowupChips';

describe('FollowupChips', () => {
  it('renders one button per followup', () => {
    render(<FollowupChips followups={['A?', 'B?', 'C?']} onPick={() => {}} />);
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(screen.getByText('A?')).toBeTruthy();
  });

  it('renders nothing when followups is empty', () => {
    const { container } = render(<FollowupChips followups={[]} onPick={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when disabled', () => {
    const { container } = render(<FollowupChips followups={['A?']} onPick={() => {}} disabled />);
    expect(container.firstChild).toBeNull();
  });

  it('calls onPick with chip text on click', () => {
    const onPick = vi.fn();
    render(<FollowupChips followups={['Hello?', 'World?']} onPick={onPick} />);
    fireEvent.click(screen.getByText('Hello?'));
    expect(onPick).toHaveBeenCalledWith('Hello?');
  });

  it('exposes aria-label "Follow-up sugerido" per chip', () => {
    render(<FollowupChips followups={['X?']} onPick={() => {}} />);
    expect(screen.getByLabelText('Follow-up sugerido: X?')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/components/chat/FollowupChips.test.tsx`
Expected: FAIL with "Cannot find module '@/components/chat/FollowupChips'".

- [ ] **Step 3: Implement the component**

Create `components/chat/FollowupChips.tsx`:

```tsx
'use client';

type Props = {
  followups: string[];
  onPick: (text: string) => void;
  disabled?: boolean;
};

export function FollowupChips({ followups, onPick, disabled }: Props) {
  if (disabled) return null;
  if (!followups || followups.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {followups.map((text, i) => (
        <button
          key={`${i}-${text}`}
          type="button"
          onClick={() => onPick(text)}
          aria-label={`Follow-up sugerido: ${text}`}
          className="rounded-full border border-border bg-background px-3 py-1.5 text-xs text-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary transition-colors"
        >
          {text}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- tests/components/chat/FollowupChips.test.tsx && npm run typecheck`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add components/chat/FollowupChips.tsx tests/components/chat/FollowupChips.test.tsx
git commit -m "$(cat <<'EOF'
feat(chat): FollowupChips component (button row, a11y)

Stateless chip row. Renders 1-3 pills, click/Enter/Space activate onPick
(native button handles keyboard). Renders nothing when empty or
disabled. Theme-aware via Tailwind tokens.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Render chips from `Message` (last assistant only)

Extend `Message` props with `followups`, `isLast`, `onPickFollowup`. Render `<FollowupChips/>` only on the last assistant message that's not streaming.

**Files:**
- Modify: `components/chat/Message.tsx`
- Modify: `tests/components/chat/Message.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `tests/components/chat/Message.test.tsx`, add new test cases inside the `describe('Message', ...)`:

```tsx
  it('renders followup chips on last assistant message when not streaming', () => {
    const { container } = render(
      <Message
        role="assistant"
        content="resposta"
        isStreaming={false}
        isLast
        followups={['A?', 'B?']}
        onPickFollowup={() => {}}
      />,
    );
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(2);
  });

  it('does NOT render chips when not last', () => {
    const { container } = render(
      <Message
        role="assistant"
        content="r"
        isStreaming={false}
        isLast={false}
        followups={['A?']}
        onPickFollowup={() => {}}
      />,
    );
    expect(container.querySelectorAll('button').length).toBe(0);
  });

  it('does NOT render chips while streaming', () => {
    const { container } = render(
      <Message
        role="assistant"
        content="r"
        isStreaming={true}
        isLast
        followups={['A?']}
        onPickFollowup={() => {}}
      />,
    );
    expect(container.querySelectorAll('button').length).toBe(0);
  });

  it('does NOT render chips for user role', () => {
    const { container } = render(
      <Message
        role="user"
        content="r"
        isStreaming={false}
        isLast
        followups={['A?']}
        onPickFollowup={() => {}}
      />,
    );
    expect(container.querySelectorAll('button').length).toBe(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/components/chat/Message.test.tsx`
Expected: FAIL — `Message` doesn't accept the new props yet.

- [ ] **Step 3: Extend `Message`**

Replace `components/chat/Message.tsx` with:

```tsx
'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageActions } from './MessageActions';
import { FollowupChips } from './FollowupChips';

type Props = {
  role: 'user' | 'assistant';
  content: string;
  isStreaming: boolean;
  traceId?: string;
  sessionId?: string;
  initialRating?: 'up' | 'down';
  followups?: string[];
  isLast?: boolean;
  onPickFollowup?: (text: string) => void;
};

export function Message({
  role,
  content,
  isStreaming,
  traceId,
  sessionId,
  initialRating,
  followups,
  isLast,
  onPickFollowup,
}: Props) {
  if (role === 'user') {
    return (
      <li className="flex justify-end">
        <div className="bg-primary text-primary-foreground max-w-[75%] rounded-2xl px-4 py-2 whitespace-pre-wrap break-words">
          {content}
        </div>
      </li>
    );
  }
  return (
    <li className="flex justify-start">
      <div className="bg-card border border-border max-w-[85%] rounded-2xl px-4 py-3">
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
        {isStreaming ? (
          <span
            data-streaming-dot
            className="inline-block ml-1 h-2 w-2 rounded-full bg-primary animate-pulse"
            aria-label="Gerando"
          />
        ) : null}
        {!isStreaming && traceId && sessionId ? (
          <MessageActions traceId={traceId} sessionId={sessionId} initialRating={initialRating} />
        ) : null}
        {!isStreaming && isLast && followups && followups.length > 0 && onPickFollowup ? (
          <FollowupChips followups={followups} onPick={onPickFollowup} />
        ) : null}
      </div>
    </li>
  );
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- tests/components/chat/Message.test.tsx && npm run typecheck`
Expected: PASS — all Message tests green (3 existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add components/chat/Message.tsx tests/components/chat/Message.test.tsx
git commit -m "$(cat <<'EOF'
feat(chat): render FollowupChips from Message on last assistant turn

Adds followups/isLast/onPickFollowup props. Chips render only when:
role=assistant, !isStreaming, isLast, non-empty followups, and a pick
handler is wired.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Thread followups + onPick through `MessageList`

Read `followups` from message annotations, derive `isLast` from index, accept and forward `onPickFollowup`.

**Files:**
- Modify: `components/chat/MessageList.tsx`

- [ ] **Step 1: Replace `MessageList.tsx`**

Replace the file with:

```tsx
'use client';

import { useEffect, useRef } from 'react';
import { Message } from './Message';
import type { ChatMessage } from '@/lib/rag/types';

type Annotation = { traceId?: string; followups?: string[] };

type UIMessage = ChatMessage & {
  id?: string;
  annotations?: unknown[];
};

type Props = {
  messages: UIMessage[];
  isLoading: boolean;
  sessionId?: string;
  initialRatings?: Map<string, 'up' | 'down'>;
  onPickFollowup?: (text: string) => void;
};

const STICK_THRESHOLD_PX = 80;

function pickTraceId(m: UIMessage): string | undefined {
  const ann = m.annotations as Annotation[] | undefined;
  const found = ann?.find((a) => typeof a?.traceId === 'string');
  return found?.traceId;
}

function pickFollowups(m: UIMessage): string[] | undefined {
  const ann = m.annotations as Annotation[] | undefined;
  const found = ann?.find((a) => Array.isArray(a?.followups));
  return found?.followups;
}

export function MessageList({ messages, isLoading, sessionId, initialRatings, onPickFollowup }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < STICK_THRESHOLD_PX) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isLoading]);

  const lastIdx = messages.length - 1;

  return (
    <div ref={ref} className="flex-1 overflow-y-auto">
      <ol className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        {messages.map((m, i) => {
          const traceId = pickTraceId(m);
          const initialRating = traceId ? initialRatings?.get(traceId) : undefined;
          const followups = pickFollowups(m);
          const isLast = i === lastIdx;
          return (
            <Message
              key={m.id ?? i}
              role={m.role === 'assistant' ? 'assistant' : 'user'}
              content={m.content}
              isStreaming={isLoading && isLast && m.role === 'assistant'}
              traceId={traceId}
              sessionId={sessionId}
              initialRating={initialRating}
              followups={followups}
              isLast={isLast}
              onPickFollowup={onPickFollowup}
            />
          );
        })}
      </ol>
    </div>
  );
}
```

- [ ] **Step 2: Run tests + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS — full suite green; existing MessageList tests untouched.

- [ ] **Step 3: Commit**

```bash
git add components/chat/MessageList.tsx
git commit -m "$(cat <<'EOF'
feat(chat): thread followups + onPickFollowup through MessageList

Reads followups from message annotations (same shape as traceId), passes
isLast computed from index, forwards onPickFollowup to the last
assistant Message.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Wire `onPick` to `useChat.append` in `ChatSession`

Pass an `onPickFollowup` to `MessageList` that calls `append({ role: 'user', content })` from the `useChat` hook.

**Files:**
- Modify: `components/chat/ChatSession.tsx`

- [ ] **Step 1: Edit `ChatSession.tsx`**

Replace the file with:

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
  initialRatings?: Map<string, 'up' | 'down'>;
  onMessagesChange: (messages: ChatMessage[]) => void;
};

function toChatMessages(messages: AIMessage[]): ChatMessage[] {
  return messages
    .filter((m): m is AIMessage & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));
}

export function ChatSession({ session, initialRatings, onMessagesChange }: Props) {
  const { messages, input, setInput, handleSubmit, isLoading, stop, append } = useChat({
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
      if (err.message.includes('rate_limited') || err.message.includes('429')) return;
      toast.error('Tivemos um problema. Tente enviar novamente.');
    },
    onFinish: (assistant) => {
      const next = toChatMessages([...messages, assistant]);
      onMessagesChange(next);
    },
  });

  const onPickFollowup = (text: string) => {
    if (isLoading) return;
    void append({ role: 'user', content: text });
  };

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
            annotations: m.annotations,
          }))}
          isLoading={isLoading}
          sessionId={session.id}
          initialRatings={initialRatings}
          onPickFollowup={onPickFollowup}
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

- [ ] **Step 2: Run full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS. Existing `ChatSession.test.tsx` should still pass; if a test asserts `useChat` destructured props, add `append: vi.fn()` to the mock.

- [ ] **Step 3: Manual smoke (dev server)**

Start dev server in background:

```bash
npm run dev
```

Open `http://localhost:3000/chat`, log in, send "O que é a matriz de Kraljic?".
Expected: response streams, then 3 chips appear below it. Click one — sends as new user message, response streams, new chips appear, old chips disappear.
Then send "o que é blockchain?".
Expected: refusal answer, then 3 reformulation chips (toward Kraljic / TCO / SRM-style).

(Stop the dev server when done.)

- [ ] **Step 4: Commit**

```bash
git add components/chat/ChatSession.tsx
git commit -m "$(cat <<'EOF'
feat(chat): wire FollowupChips picks to useChat.append

Click on a chip submits its text as a new user message via the AI SDK's
append(). Suppressed while a stream is in flight.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: CLAUDE.md update + smoke checklist + tag

Document the new sub-projeto, gotchas, and update the manual smoke test.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/product/beta-smoke-test.md`

- [ ] **Step 1: Add sub-projeto 11 row to CLAUDE.md status table**

In `CLAUDE.md`, the table that lists sub-projetos completos. Append a new row at the bottom of the table:

```markdown
| 11 | `followup-questions-complete` | `/api/chat` extends `onFinish` with `suggestFollowups` (Gemini Flash Lite, JSON, zod-validated, 3s abort timeout, fail-soft → `[]`). Two modes by `chunks.length`: **deepen** (PT/EN system prompt grounded in chunk titles + 240-char snippets) and **redirect** (PT/EN reformulation prompt nudging toward known procurement topics; no material section). Span `suggest-followups` aninhado em `chat.turn` (`level:WARNING` em erro). Trace tag `followups:empty` quando array vazio. Annotation `{ followups: string[] }` no SSE; `MessageList` lê via `pickFollowups`. `<FollowupChips/>` (button row, a11y, theme-aware) renderiza só na **última** assistant msg da sessão (não persistido em `sessions.messages`). Click invoca `useChat.append({ role:'user', content })`, virando turno normal (rate-limit per-user já cobre). Skip do passo se `finishReason !== 'stop'` ou `text.length < 20`. |
```

Update the **Test count atual** line in the Milestone 2 section (currently says "143 vitest"):

```markdown
**Test count atual:** ~168 vitest, 23 pytest, typecheck zero erros. CI gate: `recall@5 ≥ 0.85` em PR + push main.
```

(Adjust the actual number to match what `npm test` reports after Task 12.)

Append two new gotchas to the "O que evitar" list at the bottom of `CLAUDE.md`:

```markdown
- Persistir `followups` em `sessions.messages` JSONB — sub-projeto 11 deliberadamente NÃO persiste. Vivem só na annotation SSE do turno atual e desaparecem quando o próximo turno renderiza. Se um sub-projeto futuro precisar de chips em mensagens passadas, fazer schema change explícito.
- Esquecer de incluir `chunks` no mock de `runRag` em testes novos do `/api/chat` — sub-projeto 11 adicionou `chunks: RetrievedChunk[]` ao `RagResult` e o tipo cobra. Sem isso, typecheck quebra. Padrão: passar `chunks: []` quando o retrieval foi pulado, ou um array de `RetrievedChunk` com snippet relevante.
```

Update the chat end-to-end flow ASCII (the diagram block in CLAUDE.md that ends with `useChatSessionsRemote.updateMessages → DB`) to add the new step right after `generate span`:

```
                              generate span → streamText (Gemini Flash via @ai-sdk/google)
                                                                 ↓
              onFinish → end generate span
                                                                 ↓
              if finishReason==='stop' && text.length>=20 → suggestFollowups (span)
                                                                 ↓
              data.appendMessageAnnotation({ followups }) (SSE)
                                                                 ↓
              trace.end + await flushAsync (NÃO esquecer!)
                                                                 ↓
                                             useChatSessionsRemote.updateMessages → DB
```

- [ ] **Step 2: Update `docs/product/beta-smoke-test.md`**

Append a new section near the bottom:

```markdown
## Follow-up chips

- [ ] Após uma resposta fundamentada (ex.: "O que é Kraljic?"), 3 chips aparecem abaixo da resposta.
- [ ] Click num chip envia o texto como nova mensagem do usuário; chips do turno anterior somem assim que o novo turno renderiza.
- [ ] Após pergunta fora da base ("o que é blockchain?"), 3 chips de reformulação aparecem (matriz de Kraljic / TCO / Cox etc.).
- [ ] Click no botão Stop durante streaming → chips não aparecem para aquele turno.
- [ ] Tema dark e light: chips legíveis em ambos.
- [ ] Mobile (largura ≤ 480px): chips wrappam em múltiplas linhas, área de click ≥44px de altura.
```

- [ ] **Step 3: Run full suite + typecheck one last time**

Run: `npm run typecheck && npm test && npm run rag:eval`
Expected: PASS, recall@5 ≥ 0.85 (eval gate inalterado).

- [ ] **Step 4: Commit docs**

```bash
git add CLAUDE.md docs/product/beta-smoke-test.md
git commit -m "$(cat <<'EOF'
docs(CLAUDE.md): record sub-projeto 11 (follow-up questions) + gotchas

Adds the followup-questions-complete row to the status table, updates
the chat end-to-end flow with the suggest-followups step, bumps the
test count, and adds two gotchas (don't persist followups; remember
chunks: [] in runRag mocks). Smoke checklist gets a new section.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Tag the milestone**

```bash
git tag followup-questions-complete
git log --oneline -1
```

Expected: tag points at the docs commit; the previous 12 commits form the sub-projeto.

---

## Self-Review

**Spec coverage** — every numbered section maps to tasks:
- Objetivo, Princípios, Arquitetura → Tasks 1, 2, 3, 7, 8 (architecture)
- Componentes (backend) → Tasks 1, 2-7 (`lib/rag/followups.ts`), 8 (route)
- Componentes (frontend) → Tasks 9 (`FollowupChips`), 10 (`Message`), 11 (`MessageList`), 12 (`ChatSession`)
- Data flow + prompts (deepen/redirect/EN) → Tasks 2, 3, 4
- Erro / edge cases → Tasks 5, 6, 8 (skip-on-abort)
- Observabilidade (span, tag) → Tasks 7, 8
- Testing → embedded TDD-style in every task
- Critério de saída → Task 13 + tag
- CLAUDE.md update → Task 13

**Placeholder scan** — no TBDs, TODOs, "implement appropriately", or "similar to task N". Every code block is the actual content. Test bodies are full, not stubs.

**Type consistency** — `SuggestFollowupsInput` shape (Task 2 → onward) is referenced unchanged in the route call (Task 8). `RetrievedChunk` import remains canonical from `@/lib/rag/types`. `Trace` shape from `@/lib/observability/types` matches NOOP_TRACE in tests. `RagResult.chunks` introduced in Task 1 is consumed in Task 8. Component prop names (`followups`, `isLast`, `onPickFollowup`) are consistent across `Message`, `MessageList`, `FollowupChips`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-04-followup-questions.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
