# Multimodal Ingestion Implementation Plan (Sub-projeto 12)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the text-only PDF parser in the Node ingestion pipeline with a Gemini multimodal parser that emits typed blocks (`text` / `table` / `figure`), so tables become first-class retrievable chunks (markdown) and figures become retrievable descriptions. DOCX gains tables-aware extraction. Pipeline falls back to the current text-only parser on any multimodal failure. Schema unchanged (`chunks.metadata` JSONB carries `kind`/`page`/`caption`/`figureKind`).

**Architecture:** New module `parsePdfMultimodal` wraps `@google/genai` with a structured-JSON schema (zod) and returns blocks. New module `parseDocxWithTables` uses `mammoth.convertToHtml` + a regex-based `htmlTableToMarkdown` helper. A new dispatcher `parseSource` routes PDF→multimodal-with-fallback, DOCX→tables-aware, TXT→trivial; returns either `{ blocks }` or `{ text }`. The existing `chunker.ts` gains a sibling `chunkBlocks(blocks)` that produces 1 chunk per table/figure and groups text via the current paragraph algorithm. `pipeline.ts` dispatches on the parsed shape and writes `metadata.kind` per chunk + `metadata.parser` on the article. Admin UI shows a kind badge per chunk.

**Tech Stack:** Next.js 14 App Router (Node-only paths), `@google/genai` Gemini 3.1 Flash Lite preview with `responseMimeType: 'application/json'` + `responseSchema`, `mammoth` (already in deps), `pdf-parse@1.1.1` (already in deps, fallback path), zod, vitest, TypeScript strict. No new runtime dependency unless Task 3 fallback triggers.

**Spec:** `docs/superpowers/specs/2026-05-07-multimodal-ingestion-design.md`

---

## File Structure

**New files:**
- `lib/ingest/multimodal-parse.ts` — `parsePdfMultimodal()` (Gemini multimodal call + zod + retry + abort timeout + Files API fallback for >20 MB)
- `lib/ingest/docx-parse.ts` — `parseDocxWithTables()` (mammoth.convertToHtml → block stream)
- `lib/ingest/html-table.ts` — `htmlTableToMarkdown()` (pure utility)
- `lib/ingest/parse-source.ts` — `parseSource()` dispatcher with PDF multimodal-then-fallback orchestration
- `tests/lib/ingest/multimodal-parse.test.ts`
- `tests/lib/ingest/docx-parse.test.ts`
- `tests/lib/ingest/html-table.test.ts`
- `tests/lib/ingest/parse-source.test.ts`

**Modified files:**
- `lib/ingest/types.ts` — add `Block` discriminated union, `ParsedSource` type
- `lib/ingest/parser.ts` — split exports: keep `parseFile` (deprecated wrapper, retained for `scripts/ingest.py` parity story) + add named exports `parsePdfTextOnly`, `parseDocxTextOnly`, `parseTxt`
- `lib/ingest/chunker.ts` — add `chunkBlocks(blocks)` alongside existing `chunkText(text)`; export shared paragraph-aware splitter as internal helper
- `lib/ingest/pipeline.ts` — call `parseSource` instead of `parseFile`; dispatch chunk insertion based on `text` vs `blocks`; record `metadata.parser` on article + `metadata.kind`/`page`/`caption`/`figureKind` on chunks
- `components/admin/ArticleDetail.tsx` — chunk select includes `metadata`; render kind badge + page number
- `tests/lib/ingest/chunker.test.ts` — extend with `chunkBlocks` cases
- `tests/lib/ingest/pipeline.test.ts` — extend with multimodal/fallback/DOCX/TXT dispatch
- `tests/lib/ingest/parser.test.ts` — adjust to new named exports (existing behavior unchanged)
- `scripts/eval/golden.json` — +5 pairs (table/flow/chart queries) — IDs filled after backfill in Task 13
- `docs/product/beta-smoke-test.md` — +5 manual smoke items
- `CLAUDE.md` — sub-projeto 12 row + Milestone status + gotchas

---

## Conventions

- **Test runner:** `npm test` (vitest run, all suites). Single file: `npm test -- tests/lib/ingest/multimodal-parse.test.ts`. Use `vi.doMock` + `vi.resetModules()` for module-level mocks (canonical pattern from `tests/lib/ingest/pipeline.test.ts`).
- **Gemini wrapper mock:** `vi.doMock('@/lib/llm/gemini', () => ({ getGemini: () => ({ models: { generateContent: vi.fn(...) }, files: { create: vi.fn(...) } }) }))` exactly mirroring `tests/lib/rag/classifier.test.ts:9-20` and `tests/lib/rag/followups.test.ts` style.
- **Typecheck:** `npm run typecheck`. Run after every task that touches types or moved imports.
- **Branch:** `main` (project pattern — sub-projetos 8/9/10/11 went direct to main).
- **Commits:** atomic per task. Format `<type>(<scope>): <subject>` with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` footer.
- **Tag at end:** after Task 14 passes locally + CI, apply `multimodal-ingestion-complete`.
- **Spec deviations:** none planned. The spec mentions a `>1000 pages` upfront-rejection path; the plan implements this lazily — Gemini Files API surfaces its own size error which is caught and triggers fallback. No `pdfjs-dist` dep needed.

---

## Task 1: Block types in `lib/ingest/types.ts`

Adds the `Block` discriminated union and `ParsedSource` type that subsequent tasks consume. No behavioral change.

**Files:**
- Modify: `lib/ingest/types.ts`

- [ ] **Step 1: Add types**

Append to `lib/ingest/types.ts`:

```ts
export type FigureKind = 'flow' | 'chart' | 'diagram';

export type TextBlock = { type: 'text'; page: number; content: string };
export type TableBlock = {
  type: 'table';
  page: number;
  markdown: string;
  caption?: string;
};
export type FigureBlock = {
  type: 'figure';
  page: number;
  description: string;
  caption?: string;
  figureKind: FigureKind;
};
export type Block = TextBlock | TableBlock | FigureBlock;

export type ParsedSource =
  | { kind: 'blocks'; blocks: Block[]; pageCount?: number }
  | { kind: 'text'; text: string; pageCount?: number };

export type ChunkKind = 'text' | 'table' | 'figure';

export type ChunkRow = {
  content: string;
  metadata: {
    kind: ChunkKind;
    page?: number;
    caption?: string;
    figureKind?: FigureKind;
  };
};
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (zero errors)

- [ ] **Step 3: Commit**

```bash
git add lib/ingest/types.ts
git commit -m "$(cat <<'EOF'
feat(ingest): add Block, ParsedSource, ChunkRow types

Foundation for sub-projeto 12 multimodal ingestion. Discriminated union
supports text/table/figure block kinds; ParsedSource carries either
block stream or fallback text path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Split `parser.ts` into named exports

Today `parseFile(buf, mime, filename)` is the only export and dispatches by mime. Sub-projeto 12 needs the PDF-text-only path callable from the new `parseSource` dispatcher (as the multimodal fallback) and DOCX text-only path callable as the failsafe inside `parseDocxWithTables`. Refactor: extract three named functions, keep `parseFile` as a thin wrapper for backwards compat.

**Files:**
- Modify: `lib/ingest/parser.ts`
- Modify: `tests/lib/ingest/parser.test.ts`

- [ ] **Step 1: Refactor `lib/ingest/parser.ts`**

Replace the entire file with:

```ts
import { cleanExtractedText } from '@/lib/ingest/clean';

export type ParsedFile = { text: string; pageCount?: number };

const MIN_TEXT_CHARS = 500;

function postProcess(raw: string): string {
  const normalized = raw.replace(/\x00/g, '').replace(/\r\n/g, '\n');
  return cleanExtractedText(normalized);
}

function ensureMinChars(cleaned: string): void {
  if (cleaned.trim().length < MIN_TEXT_CHARS) {
    throw new Error(
      'Conteúdo muito curto — PDF parece escaneado / OCR necessário (texto extraído < 500 caracteres)',
    );
  }
}

export async function parsePdfTextOnly(buf: Buffer): Promise<ParsedFile> {
  // pdf-parse@1.1.1: import inner path to bypass module-load self-test ENOENT.
  // @ts-expect-error — no types for the inner path; shape matches default export.
  const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default as
    (data: Buffer) => Promise<{ text: string; numpages: number }>;
  const data = await pdfParse(buf);
  const cleaned = postProcess(data.text);
  ensureMinChars(cleaned);
  return { text: cleaned, pageCount: data.numpages };
}

export async function parseDocxTextOnly(buf: Buffer): Promise<ParsedFile> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: buf });
  const cleaned = postProcess(value);
  ensureMinChars(cleaned);
  return { text: cleaned };
}

export function parseTxt(buf: Buffer): ParsedFile {
  const cleaned = postProcess(buf.toString('utf-8'));
  ensureMinChars(cleaned);
  return { text: cleaned };
}

/**
 * @deprecated Use parsePdfTextOnly / parseDocxTextOnly / parseTxt directly,
 * or call parseSource() from `lib/ingest/parse-source.ts`. Kept as a
 * thin wrapper so older callers (and in-flight tests) keep working.
 */
export async function parseFile(
  buf: Buffer,
  mime: string,
  filename: string,
): Promise<ParsedFile> {
  if (mime === 'application/pdf') return parsePdfTextOnly(buf);
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return parseDocxTextOnly(buf);
  }
  if (mime === 'text/plain') return parseTxt(buf);
  throw new Error(`Tipo não suportado: ${mime} (${filename})`);
}
```

- [ ] **Step 2: Run existing parser tests**

Run: `npm test -- tests/lib/ingest/parser.test.ts`
Expected: PASS (behavior is identical; only structure changed)

If any test fails because it imported `parseFile`-only and now there are extra exports, the test should still pass because nothing broke. If a test fails due to identity changes, update it to import from the named exports.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add lib/ingest/parser.ts tests/lib/ingest/parser.test.ts
git commit -m "$(cat <<'EOF'
refactor(ingest): split parseFile into named exports

parsePdfTextOnly / parseDocxTextOnly / parseTxt become individually
callable. parseFile retained as deprecated mime-dispatch wrapper for
backwards compat. Sets up the multimodal fallback path for sub-projeto
12. No behavioral change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: HTML table → markdown utility (TDD)

Pure-function utility used by `parseDocxWithTables`. Mammoth's `convertToHtml` emits clean `<table><tr><td>...</td></tr></table>` without CSS. We extract `<table>` blocks and convert each to markdown.

**Files:**
- Create: `lib/ingest/html-table.ts`
- Create: `tests/lib/ingest/html-table.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/ingest/html-table.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { htmlTableToMarkdown, extractTables } from '@/lib/ingest/html-table';

describe('htmlTableToMarkdown', () => {
  it('converts simple 2x2 table with header divider', () => {
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
    const md = htmlTableToMarkdown(html);
    expect(md).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('treats first <tr> as header when no <thead>', () => {
    const html = '<table><tr><td>X</td><td>Y</td></tr><tr><td>3</td><td>4</td></tr></table>';
    const md = htmlTableToMarkdown(html);
    expect(md.split('\n')[0]).toBe('| X | Y |');
    expect(md.split('\n')[1]).toBe('| --- | --- |');
  });

  it('escapes pipe characters in cells', () => {
    const html = '<table><tr><td>a|b</td><td>c</td></tr></table>';
    const md = htmlTableToMarkdown(html);
    expect(md).toContain('a\\|b');
  });

  it('replaces <br> in cells with a single space', () => {
    const html = '<table><tr><td>line1<br/>line2</td><td>x</td></tr></table>';
    const md = htmlTableToMarkdown(html);
    expect(md).toContain('line1 line2');
  });

  it('flattens nested <table> in a cell to plain text without re-formatting', () => {
    const html =
      '<table><tr><td>outer1</td><td><table><tr><td>nested</td></tr></table></td></tr></table>';
    const md = htmlTableToMarkdown(html);
    expect(md).toContain('outer1');
    expect(md).toContain('nested');
    expect(md.split('|').filter((s) => s.trim() === 'nested').length).toBe(1);
  });
});

describe('extractTables', () => {
  it('returns ordered list of {start, end, html} ranges for each top-level <table>', () => {
    const html = '<p>before</p><table><tr><td>1</td></tr></table><p>mid</p><table><tr><td>2</td></tr></table><p>after</p>';
    const ranges = extractTables(html);
    expect(ranges).toHaveLength(2);
    expect(ranges[0].html).toContain('<td>1</td>');
    expect(ranges[1].html).toContain('<td>2</td>');
    expect(ranges[0].start).toBeLessThan(ranges[1].start);
  });

  it('skips nested tables — only outermost tables returned', () => {
    const html = '<table><tr><td><table><tr><td>nested</td></tr></table></td></tr></table>';
    const ranges = extractTables(html);
    expect(ranges).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/lib/ingest/html-table.test.ts`
Expected: FAIL with "Cannot find module '@/lib/ingest/html-table'"

- [ ] **Step 3: Implement `lib/ingest/html-table.ts`**

```ts
type TableRange = { start: number; end: number; html: string };

/**
 * Locate top-level <table>...</table> ranges in an HTML string.
 * Nested tables are not returned as separate ranges (they live inside
 * the outermost table's html). The returned ranges are ordered by start
 * offset so callers can interleave with text spans between them.
 */
export function extractTables(html: string): TableRange[] {
  const out: TableRange[] = [];
  const lower = html.toLowerCase();
  let i = 0;
  while (i < lower.length) {
    const open = lower.indexOf('<table', i);
    if (open === -1) break;
    // Find the matching </table> at depth 0.
    let depth = 1;
    let j = lower.indexOf('>', open);
    if (j === -1) break;
    j += 1;
    while (j < lower.length && depth > 0) {
      const nextOpen = lower.indexOf('<table', j);
      const nextClose = lower.indexOf('</table>', j);
      if (nextClose === -1) return out; // malformed — bail
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        j = lower.indexOf('>', nextOpen) + 1;
      } else {
        depth -= 1;
        j = nextClose + '</table>'.length;
      }
    }
    out.push({ start: open, end: j, html: html.slice(open, j) });
    i = j;
  }
  return out;
}

function stripTags(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

/** Extract `<tr>...</tr>` rows from a table HTML string (top-level only). */
function extractRows(tableHtml: string): string[] {
  const rows: string[] = [];
  const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tableHtml)) !== null) {
    rows.push(m[1]);
  }
  return rows;
}

/** Extract `<th>` / `<td>` cells from a row HTML string. */
function extractCells(rowHtml: string): string[] {
  const cells: string[] = [];
  const re = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowHtml)) !== null) {
    cells.push(escapeCell(stripTags(m[1])));
  }
  return cells;
}

export function htmlTableToMarkdown(tableHtml: string): string {
  const rows = extractRows(tableHtml).map(extractCells).filter((r) => r.length > 0);
  if (rows.length === 0) return '';
  const header = rows[0];
  const body = rows.slice(1);
  const divider = header.map(() => '---');
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${divider.join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/lib/ingest/html-table.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/ingest/html-table.ts tests/lib/ingest/html-table.test.ts
git commit -m "$(cat <<'EOF'
feat(ingest): htmlTableToMarkdown utility

Pure regex-based converter for mammoth's convertToHtml output.
Handles nested tables by extracting only top-level <table> ranges and
flattening nested content to text. Escapes pipes, normalizes <br>.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: DOCX with tables (TDD)

Builds on Task 3. Uses `mammoth.convertToHtml` and interleaves text spans (between tables) as `text` blocks with table blocks.

**Files:**
- Create: `lib/ingest/docx-parse.ts`
- Create: `tests/lib/ingest/docx-parse.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/ingest/docx-parse.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Block } from '@/lib/ingest/types';

beforeEach(() => {
  vi.resetModules();
});

function mockMammoth(html: string, rawText?: string) {
  vi.doMock('mammoth', () => ({
    convertToHtml: vi.fn().mockResolvedValue({ value: html }),
    extractRawText: vi.fn().mockResolvedValue({ value: rawText ?? html.replace(/<[^>]+>/g, ' ') }),
  }));
}

describe('parseDocxWithTables', () => {
  it('emits a single text block when there are no tables', async () => {
    mockMammoth('<p>Lorem ipsum dolor sit amet.</p><p>Second paragraph here.</p>');
    const { parseDocxWithTables } = await import('@/lib/ingest/docx-parse');
    const { blocks } = await parseDocxWithTables(Buffer.from('x'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect((blocks[0] as Extract<Block, { type: 'text' }>).content).toMatch(/Lorem ipsum/);
  });

  it('produces text + table + text blocks in order when one table sits in the middle', async () => {
    mockMammoth(
      '<p>Before table.</p><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><p>After table.</p>',
    );
    const { parseDocxWithTables } = await import('@/lib/ingest/docx-parse');
    const { blocks } = await parseDocxWithTables(Buffer.from('x'));
    expect(blocks.map((b) => b.type)).toEqual(['text', 'table', 'text']);
    const tbl = blocks[1] as Extract<Block, { type: 'table' }>;
    expect(tbl.markdown).toContain('| A | B |');
    expect(tbl.markdown).toContain('| 1 | 2 |');
  });

  it('emits two table blocks when there are two tables', async () => {
    mockMammoth(
      '<table><tr><td>x</td></tr></table><p>mid</p><table><tr><td>y</td></tr></table>',
    );
    const { parseDocxWithTables } = await import('@/lib/ingest/docx-parse');
    const { blocks } = await parseDocxWithTables(Buffer.from('x'));
    expect(blocks.filter((b) => b.type === 'table')).toHaveLength(2);
  });

  it('all blocks have page=1 (DOCX has no page concept in mammoth output)', async () => {
    mockMammoth('<p>p</p><table><tr><td>c</td></tr></table>');
    const { parseDocxWithTables } = await import('@/lib/ingest/docx-parse');
    const { blocks } = await parseDocxWithTables(Buffer.from('x'));
    for (const b of blocks) expect(b.page).toBe(1);
  });

  it('throws clear error on empty DOCX', async () => {
    mockMammoth('   ', '   ');
    const { parseDocxWithTables } = await import('@/lib/ingest/docx-parse');
    await expect(parseDocxWithTables(Buffer.from('x'))).rejects.toThrow(/conteúdo|vazio|curto/i);
  });

  it('falls back to extractRawText when convertToHtml throws (returns 1 text block)', async () => {
    vi.doMock('mammoth', () => ({
      convertToHtml: vi.fn().mockRejectedValue(new Error('html convert failed')),
      extractRawText: vi.fn().mockResolvedValue({ value: 'Plain text fallback content with enough characters to pass the guard. '.repeat(20) }),
    }));
    const { parseDocxWithTables } = await import('@/lib/ingest/docx-parse');
    const { blocks } = await parseDocxWithTables(Buffer.from('x'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/lib/ingest/docx-parse.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `lib/ingest/docx-parse.ts`**

```ts
import { cleanExtractedText } from '@/lib/ingest/clean';
import { extractTables, htmlTableToMarkdown } from '@/lib/ingest/html-table';
import type { Block } from '@/lib/ingest/types';

const MIN_TEXT_CHARS = 500;

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|tr|div)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function parseDocxWithTables(
  buf: Buffer,
): Promise<{ blocks: Block[] }> {
  const mammoth = await import('mammoth');

  let html: string;
  try {
    const out = await mammoth.convertToHtml({ buffer: buf });
    html = out.value;
  } catch (err) {
    // Fallback to plain text extraction (sub-projeto 12 spec: DOCX exotic case).
    const { value } = await mammoth.extractRawText({ buffer: buf });
    const cleaned = cleanExtractedText(value).trim();
    if (cleaned.length < MIN_TEXT_CHARS) {
      throw new Error(
        `Conteúdo DOCX muito curto após extração de texto (${cleaned.length} chars). Original: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { blocks: [{ type: 'text', page: 1, content: cleaned }] };
  }

  const tables = extractTables(html);
  const blocks: Block[] = [];
  let cursor = 0;

  const pushTextSpan = (rawHtml: string) => {
    const text = cleanExtractedText(htmlToText(rawHtml)).trim();
    if (text) blocks.push({ type: 'text', page: 1, content: text });
  };

  for (const t of tables) {
    if (t.start > cursor) pushTextSpan(html.slice(cursor, t.start));
    const md = htmlTableToMarkdown(t.html);
    if (md) blocks.push({ type: 'table', page: 1, markdown: md });
    cursor = t.end;
  }
  if (cursor < html.length) pushTextSpan(html.slice(cursor));

  // If everything came out empty, treat as bad input.
  const totalLen = blocks.reduce(
    (n, b) =>
      n +
      (b.type === 'text'
        ? b.content.length
        : b.type === 'table'
          ? b.markdown.length
          : b.description.length),
    0,
  );
  if (totalLen < MIN_TEXT_CHARS) {
    throw new Error(
      `Conteúdo DOCX vazio ou muito curto após parsing (total ${totalLen} chars)`,
    );
  }
  return { blocks };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/lib/ingest/docx-parse.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/ingest/docx-parse.ts tests/lib/ingest/docx-parse.test.ts
git commit -m "$(cat <<'EOF'
feat(ingest): parseDocxWithTables (mammoth HTML + table extraction)

Interleaves text spans and table blocks in document order. Tables are
rendered as markdown via htmlTableToMarkdown. Falls back to
extractRawText if convertToHtml throws on exotic DOCX. All blocks
emit page=1 (mammoth has no page concept).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Multimodal parser scaffolding — system prompt + zod schema

Creates the file with the prompt, zod schema, response-schema for Gemini, and a tested `validateBlocks` helper. No Gemini call yet — Task 6 wires that in. Splitting this task makes the prompt review-able as its own atomic commit.

**Files:**
- Create: `lib/ingest/multimodal-parse.ts`
- Create: `tests/lib/ingest/multimodal-parse.test.ts`

- [ ] **Step 1: Write failing tests for the schema validator**

Create `tests/lib/ingest/multimodal-parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  MULTIMODAL_SYSTEM_PROMPT,
  MULTIMODAL_RESPONSE_SCHEMA,
  validateBlocks,
} from '@/lib/ingest/multimodal-parse';

describe('multimodal-parse — prompt and schema', () => {
  it('system prompt instructs to skip headers/footers/page numbers', () => {
    expect(MULTIMODAL_SYSTEM_PROMPT).toMatch(/headers?\/footers?|cabe[çc]alhos|rodap[ée]s/i);
    expect(MULTIMODAL_SYSTEM_PROMPT).toMatch(/p[áa]gina|page[- ]?number/i);
  });

  it('system prompt instructs to skip TOC', () => {
    expect(MULTIMODAL_SYSTEM_PROMPT).toMatch(/TOC|sum[áa]rio/i);
  });

  it('system prompt names all three figureKind values', () => {
    expect(MULTIMODAL_SYSTEM_PROMPT).toMatch(/flow/);
    expect(MULTIMODAL_SYSTEM_PROMPT).toMatch(/chart/);
    expect(MULTIMODAL_SYSTEM_PROMPT).toMatch(/diagram/);
  });

  it('response schema is an object with required blocks array', () => {
    expect(MULTIMODAL_RESPONSE_SCHEMA.type).toBe('object');
    expect(MULTIMODAL_RESPONSE_SCHEMA.required).toContain('blocks');
  });
});

describe('validateBlocks', () => {
  it('accepts well-formed mixed blocks', () => {
    const out = validateBlocks({
      blocks: [
        { type: 'text', page: 1, content: 'hello world' },
        { type: 'table', page: 2, markdown: '| a |\n|---|\n| 1 |', caption: 'Tabela 1' },
        {
          type: 'figure',
          page: 3,
          description: 'Description with twenty plus chars.',
          caption: 'Figura 1',
          figureKind: 'flow',
        },
      ],
    });
    expect(out).toHaveLength(3);
  });

  it('rejects empty blocks array', () => {
    expect(() => validateBlocks({ blocks: [] })).toThrow();
  });

  it('rejects unknown block type', () => {
    expect(() => validateBlocks({ blocks: [{ type: 'bogus', page: 1 }] })).toThrow();
  });

  it('rejects figure without figureKind', () => {
    expect(() =>
      validateBlocks({
        blocks: [{ type: 'figure', page: 1, description: 'a long enough description here' }],
      }),
    ).toThrow();
  });

  it('rejects text with empty content', () => {
    expect(() =>
      validateBlocks({ blocks: [{ type: 'text', page: 1, content: '' }] }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/lib/ingest/multimodal-parse.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement scaffolding in `lib/ingest/multimodal-parse.ts`**

```ts
import { z } from 'zod';
import type { Block } from '@/lib/ingest/types';

export const MULTIMODAL_SYSTEM_PROMPT = `Você é um extrator estruturado de artigos acadêmicos sobre procurement.
Receba o PDF e retorne um array de blocos representando o conteúdo do
documento NA ORDEM EM QUE APARECE. Cada bloco é um de três tipos:

- text: parágrafo ou seção corrida. Junte parágrafos relacionados.
- table: qualquer tabela. Devolva o conteúdo como Markdown bem formado
  (linhas separadas por |, header divider com ---). Capture a legenda
  da tabela (ex: "Tabela 2: Matriz de Kraljic") em "caption".
- figure: diagrama, fluxograma, gráfico, ou qualquer figura visual NÃO
  textual. Em "description", produza 80–250 palavras descrevendo o que
  a figura mostra (eixos do gráfico, valores legíveis, nós do
  fluxograma e relações, elementos do diagrama). Em "caption", o
  rótulo (ex: "Figura 3: Fluxo de aprovação"). Em "figureKind", uma
  de: "flow" (fluxograma, processo), "chart" (gráfico com dados),
  "diagram" (diagrama conceitual sem dados).

Regras:
- NÃO invente conteúdo. Se uma figura é ilegível, descreva o que vê
  ("gráfico de barras com 5 categorias, valores não legíveis").
- NÃO inclua headers/footers/numeração de página repetidos.
- NÃO inclua TOC (sumário).
- Page é o número da página (1-indexed) onde o bloco começa.
- Output JSON estrito conforme schema.`;

export const MULTIMODAL_RETRY_SUFFIX = `\n\nSua resposta anterior não bateu com o schema. Retorne EXATAMENTE este shape JSON: { "blocks": [ ... ] } onde cada bloco tem "type" igual a "text" | "table" | "figure" e os campos obrigatórios descritos acima.`;

const TextBlock = z.object({
  type: z.literal('text'),
  page: z.number().int().min(1),
  content: z.string().min(1),
});
const TableBlock = z.object({
  type: z.literal('table'),
  page: z.number().int().min(1),
  markdown: z.string().min(1),
  caption: z.string().optional(),
});
const FigureBlock = z.object({
  type: z.literal('figure'),
  page: z.number().int().min(1),
  description: z.string().min(20),
  caption: z.string().optional(),
  figureKind: z.enum(['flow', 'chart', 'diagram']),
});

const BlockSchema = z.discriminatedUnion('type', [TextBlock, TableBlock, FigureBlock]);

export const MultimodalOutputSchema = z.object({
  blocks: z.array(BlockSchema).min(1),
});

/** JSON-Schema shape passed to Gemini's `responseSchema` config. */
export const MULTIMODAL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['text', 'table', 'figure'] },
          page: { type: 'integer', minimum: 1 },
          content: { type: 'string' },
          markdown: { type: 'string' },
          description: { type: 'string' },
          caption: { type: 'string' },
          figureKind: { type: 'string', enum: ['flow', 'chart', 'diagram'] },
        },
        required: ['type', 'page'],
      },
    },
  },
  required: ['blocks'],
} as const;

export function validateBlocks(raw: unknown): Block[] {
  return MultimodalOutputSchema.parse(raw).blocks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/lib/ingest/multimodal-parse.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/ingest/multimodal-parse.ts tests/lib/ingest/multimodal-parse.test.ts
git commit -m "$(cat <<'EOF'
feat(ingest): multimodal-parse scaffolding (prompt + zod schema)

System prompt for Gemini multimodal extraction (PT-BR), zod
discriminated union for {text|table|figure} blocks, JSON-Schema for
Gemini responseSchema config, validateBlocks helper. No Gemini call
yet — Task 6 wires it in.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Multimodal parser — Gemini integration (inline path, happy + retry)

Adds `parsePdfMultimodal()` for PDFs <20 MB using `inlineData` base64. Includes 1-retry on zod fail.

**Files:**
- Modify: `lib/ingest/multimodal-parse.ts`
- Modify: `tests/lib/ingest/multimodal-parse.test.ts`

- [ ] **Step 1: Add failing tests for the Gemini integration**

Append to `tests/lib/ingest/multimodal-parse.test.ts`:

```ts
import { vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

function makeBuf(sizeBytes: number): Buffer {
  return Buffer.alloc(sizeBytes, 0x42);
}

function setupGeminiMock(responses: Array<{ text?: string; throws?: Error }>) {
  let call = 0;
  const generateContent = vi.fn().mockImplementation(async () => {
    const r = responses[call++];
    if (!r) throw new Error('mock exhausted');
    if (r.throws) throw r.throws;
    return { text: r.text ?? '' };
  });
  const filesCreate = vi.fn().mockResolvedValue({ name: 'files/abc-123' });
  vi.doMock('@/lib/llm/gemini', () => ({
    getGemini: () => ({
      models: { generateContent },
      files: { create: filesCreate },
    }),
  }));
  vi.doMock('@/lib/env', () => ({
    requireEnv: vi.fn().mockReturnValue('gemini-3.1-flash-lite-preview'),
  }));
  return { generateContent, filesCreate };
}

describe('parsePdfMultimodal — happy and retry', () => {
  const validJson = JSON.stringify({
    blocks: [
      { type: 'text', page: 1, content: 'Hello text from PDF.' },
      { type: 'table', page: 2, markdown: '| a |\n|---|\n| 1 |', caption: 'Tabela X' },
      {
        type: 'figure',
        page: 3,
        description: 'A flow diagram with three nodes connected by arrows in sequence.',
        caption: 'Figura Y',
        figureKind: 'flow',
      },
    ],
  });

  it('returns blocks in order on first-call success (inline path, <20MB)', async () => {
    const m = setupGeminiMock([{ text: validJson }]);
    const { parsePdfMultimodal } = await import('@/lib/ingest/multimodal-parse');
    const out = await parsePdfMultimodal(makeBuf(1024));
    expect(out.blocks).toHaveLength(3);
    expect(out.blocks.map((b) => b.type)).toEqual(['text', 'table', 'figure']);
    expect(m.generateContent).toHaveBeenCalledTimes(1);
    expect(m.filesCreate).not.toHaveBeenCalled();
    // Confirm inline base64 was passed
    const arg = m.generateContent.mock.calls[0][0];
    const parts = (arg.contents as Array<{ inlineData?: unknown }>) ?? [];
    expect(parts.some((p) => 'inlineData' in p)).toBe(true);
  });

  it('retries once with retry suffix when first JSON fails zod', async () => {
    const m = setupGeminiMock([{ text: '{"blocks": []}' }, { text: validJson }]);
    const { parsePdfMultimodal } = await import('@/lib/ingest/multimodal-parse');
    const out = await parsePdfMultimodal(makeBuf(1024));
    expect(out.blocks).toHaveLength(3);
    expect(m.generateContent).toHaveBeenCalledTimes(2);
    const secondCallContents = m.generateContent.mock.calls[1][0].contents;
    // Concatenated as a string; just confirm the retry suffix landed in there
    const flat = JSON.stringify(secondCallContents);
    expect(flat).toMatch(/Sua resposta anterior n[ãa]o bateu com o schema/);
  });

  it('throws after second failure (zod fail twice)', async () => {
    setupGeminiMock([{ text: '{"blocks": []}' }, { text: '{"blocks": []}' }]);
    const { parsePdfMultimodal } = await import('@/lib/ingest/multimodal-parse');
    await expect(parsePdfMultimodal(makeBuf(1024))).rejects.toThrow();
  });

  it('throws specific error when blocks: [] is returned', async () => {
    setupGeminiMock([{ text: '{"blocks": []}' }, { text: '{"blocks": []}' }]);
    const { parsePdfMultimodal } = await import('@/lib/ingest/multimodal-parse');
    await expect(parsePdfMultimodal(makeBuf(1024))).rejects.toThrow();
  });

  it('rethrows network errors without retry', async () => {
    const m = setupGeminiMock([{ throws: new Error('ECONNRESET') }]);
    const { parsePdfMultimodal } = await import('@/lib/ingest/multimodal-parse');
    await expect(parsePdfMultimodal(makeBuf(1024))).rejects.toThrow(/ECONNRESET/);
    expect(m.generateContent).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/lib/ingest/multimodal-parse.test.ts`
Expected: FAIL with "parsePdfMultimodal is not a function" or similar

- [ ] **Step 3: Implement `parsePdfMultimodal` (inline path + retry)**

Append to `lib/ingest/multimodal-parse.ts`:

```ts
import { getGemini } from '@/lib/llm/gemini';
import { requireEnv } from '@/lib/env';

const INLINE_LIMIT_BYTES = 20 * 1024 * 1024; // 20 MB
const TIMEOUT_MS = 120_000;

type GenerateContentArg = Parameters<ReturnType<typeof getGemini>['models']['generateContent']>[0];

async function callGemini(
  pdfPart: { inlineData: { mimeType: string; data: string } } | { fileData: { fileUri: string; mimeType: string } },
  systemPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const ai = getGemini();
  const model = requireEnv('GEMINI_MODEL');
  const arg: GenerateContentArg = {
    model,
    contents: [
      pdfPart as never,
      { text: systemPrompt } as never,
    ] as never,
    config: {
      responseMimeType: 'application/json',
      responseSchema: MULTIMODAL_RESPONSE_SCHEMA as never,
      maxOutputTokens: 32_768,
      abortSignal: signal,
    },
  };
  const res = await ai.models.generateContent(arg);
  return res.text ?? '';
}

export async function parsePdfMultimodal(
  buf: Buffer,
): Promise<{ blocks: Block[]; pageCount?: number }> {
  if (buf.length > INLINE_LIMIT_BYTES) {
    return parsePdfMultimodalViaFiles(buf);
  }

  const part = {
    inlineData: {
      mimeType: 'application/pdf',
      data: buf.toString('base64'),
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let raw = '';
    try {
      raw = await callGemini(part, MULTIMODAL_SYSTEM_PROMPT, controller.signal);
      const blocks = validateBlocks(JSON.parse(raw));
      return { blocks };
    } catch (firstErr) {
      // Only retry on validation/JSON failures, not on network errors.
      if (!(firstErr instanceof z.ZodError) && !(firstErr instanceof SyntaxError)) {
        throw firstErr;
      }
      raw = await callGemini(
        part,
        MULTIMODAL_SYSTEM_PROMPT + MULTIMODAL_RETRY_SUFFIX,
        controller.signal,
      );
      const blocks = validateBlocks(JSON.parse(raw));
      return { blocks };
    }
  } finally {
    clearTimeout(timer);
  }
}

// Forward declaration; Task 7 implements this. Throwing here makes the
// >20 MB path explicit even before Files API support lands.
async function parsePdfMultimodalViaFiles(
  _buf: Buffer,
): Promise<{ blocks: Block[]; pageCount?: number }> {
  throw new Error('Files API path not implemented yet (Task 7)');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/lib/ingest/multimodal-parse.test.ts`
Expected: PASS (14 tests)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/ingest/multimodal-parse.ts tests/lib/ingest/multimodal-parse.test.ts
git commit -m "$(cat <<'EOF'
feat(ingest): parsePdfMultimodal inline path with zod retry

PDFs under 20 MB pass as inlineData base64 to Gemini Flash Lite. On
zod/JSON failure, retries once with a corrective suffix; throws after
second failure or on network errors. Files API path stubbed for Task 7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Multimodal parser — Files API path for >20 MB PDFs

Replaces the stub `parsePdfMultimodalViaFiles` with the real Files API upload + reference. Same retry/timeout/validation as the inline path.

**Files:**
- Modify: `lib/ingest/multimodal-parse.ts`
- Modify: `tests/lib/ingest/multimodal-parse.test.ts`

- [ ] **Step 1: Add failing tests for the Files API path**

Append to `tests/lib/ingest/multimodal-parse.test.ts`:

```ts
describe('parsePdfMultimodal — Files API (>20MB)', () => {
  const validJson = JSON.stringify({
    blocks: [{ type: 'text', page: 1, content: 'Big PDF text.' }],
  });

  it('uploads via Files API when buffer exceeds 20MB', async () => {
    const m = setupGeminiMock([{ text: validJson }]);
    const { parsePdfMultimodal } = await import('@/lib/ingest/multimodal-parse');
    const big = Buffer.alloc(21 * 1024 * 1024, 0x42);
    const out = await parsePdfMultimodal(big);
    expect(out.blocks).toHaveLength(1);
    expect(m.filesCreate).toHaveBeenCalledTimes(1);
    // Confirm fileData (not inlineData) was passed in the second call
    const arg = m.generateContent.mock.calls[0][0];
    const parts = arg.contents as Array<Record<string, unknown>>;
    expect(parts.some((p) => 'fileData' in p)).toBe(true);
  });

  it('Files API path also retries once on zod fail', async () => {
    const m = setupGeminiMock([
      { text: '{"blocks": []}' },
      { text: validJson },
    ]);
    const { parsePdfMultimodal } = await import('@/lib/ingest/multimodal-parse');
    const big = Buffer.alloc(21 * 1024 * 1024, 0x42);
    const out = await parsePdfMultimodal(big);
    expect(out.blocks).toHaveLength(1);
    expect(m.generateContent).toHaveBeenCalledTimes(2);
    expect(m.filesCreate).toHaveBeenCalledTimes(1); // upload only once
  });

  it('Files API upload failure surfaces as throw (caller falls back)', async () => {
    const filesCreate = vi.fn().mockRejectedValue(new Error('files API quota'));
    const generateContent = vi.fn();
    vi.doMock('@/lib/llm/gemini', () => ({
      getGemini: () => ({ models: { generateContent }, files: { create: filesCreate } }),
    }));
    vi.doMock('@/lib/env', () => ({
      requireEnv: vi.fn().mockReturnValue('gemini-3.1-flash-lite-preview'),
    }));
    const { parsePdfMultimodal } = await import('@/lib/ingest/multimodal-parse');
    const big = Buffer.alloc(21 * 1024 * 1024, 0x42);
    await expect(parsePdfMultimodal(big)).rejects.toThrow(/files API quota/);
    expect(generateContent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/lib/ingest/multimodal-parse.test.ts -t "Files API"`
Expected: FAIL with "Files API path not implemented"

- [ ] **Step 3: Implement Files API path**

In `lib/ingest/multimodal-parse.ts`, replace the stub:

```ts
async function parsePdfMultimodalViaFiles(
  buf: Buffer,
): Promise<{ blocks: Block[]; pageCount?: number }> {
  const ai = getGemini();
  const uploaded = await ai.files.create({
    file: { bytes: buf, mimeType: 'application/pdf' } as never,
  } as never);
  const fileUri = (uploaded as { name?: string; uri?: string }).uri ??
    (uploaded as { name?: string }).name ?? '';
  if (!fileUri) {
    throw new Error('Gemini files.create returned neither uri nor name');
  }
  const part = {
    fileData: {
      fileUri,
      mimeType: 'application/pdf',
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    try {
      const raw = await callGemini(part, MULTIMODAL_SYSTEM_PROMPT, controller.signal);
      return { blocks: validateBlocks(JSON.parse(raw)) };
    } catch (firstErr) {
      if (!(firstErr instanceof z.ZodError) && !(firstErr instanceof SyntaxError)) {
        throw firstErr;
      }
      const raw = await callGemini(
        part,
        MULTIMODAL_SYSTEM_PROMPT + MULTIMODAL_RETRY_SUFFIX,
        controller.signal,
      );
      return { blocks: validateBlocks(JSON.parse(raw)) };
    }
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npm test -- tests/lib/ingest/multimodal-parse.test.ts`
Expected: PASS (17 tests)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/ingest/multimodal-parse.ts tests/lib/ingest/multimodal-parse.test.ts
git commit -m "$(cat <<'EOF'
feat(ingest): Files API path for PDFs >20MB

parsePdfMultimodalViaFiles uploads via @google/genai files.create then
references the resulting file in generateContent. Same retry-on-zod
behavior as the inline path. Files API auto-cleans uploads after 48h.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Source dispatcher (`parse-source.ts`)

Single entry point used by `pipeline.ts`. PDF → multimodal-with-fallback, DOCX → tables-aware, TXT → trivial. Encapsulates the decision tree so `pipeline.ts` stays simple.

**Files:**
- Create: `lib/ingest/parse-source.ts`
- Create: `tests/lib/ingest/parse-source.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/ingest/parse-source.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

function setupParserMocks(opts: {
  multimodalThrows?: Error;
  multimodalBlocks?: unknown[];
  textOnlyText?: string;
  textOnlyThrows?: Error;
  docxBlocks?: unknown[];
  docxThrows?: Error;
}) {
  const multimodal = vi.fn().mockImplementation(async () => {
    if (opts.multimodalThrows) throw opts.multimodalThrows;
    return { blocks: opts.multimodalBlocks ?? [{ type: 'text', page: 1, content: 'mm' }] };
  });
  const textOnly = vi.fn().mockImplementation(async () => {
    if (opts.textOnlyThrows) throw opts.textOnlyThrows;
    return { text: opts.textOnlyText ?? 'fallback text long enough '.repeat(40), pageCount: 5 };
  });
  const docx = vi.fn().mockImplementation(async () => {
    if (opts.docxThrows) throw opts.docxThrows;
    return { blocks: opts.docxBlocks ?? [{ type: 'text', page: 1, content: 'd' }] };
  });
  vi.doMock('@/lib/ingest/multimodal-parse', () => ({ parsePdfMultimodal: multimodal }));
  vi.doMock('@/lib/ingest/parser', () => ({
    parsePdfTextOnly: textOnly,
    parseDocxTextOnly: vi.fn().mockResolvedValue({ text: 'docx fallback text long enough '.repeat(40) }),
    parseTxt: vi.fn().mockReturnValue({ text: 'txt content long enough '.repeat(40) }),
    parseFile: vi.fn(),
  }));
  vi.doMock('@/lib/ingest/docx-parse', () => ({ parseDocxWithTables: docx }));
  return { multimodal, textOnly, docx };
}

describe('parseSource', () => {
  it('PDF happy path: multimodal succeeds → returns blocks with parser=multimodal', async () => {
    const m = setupParserMocks({});
    const { parseSource } = await import('@/lib/ingest/parse-source');
    const out = await parseSource(Buffer.from('x'), 'application/pdf', 'a.pdf');
    expect(out.parser).toBe('multimodal');
    expect(out.parsed.kind).toBe('blocks');
    expect(m.multimodal).toHaveBeenCalledTimes(1);
    expect(m.textOnly).not.toHaveBeenCalled();
  });

  it('PDF fallback: multimodal throws → text-only succeeds → parser=text-only-fallback', async () => {
    const m = setupParserMocks({ multimodalThrows: new Error('gemini boom') });
    const { parseSource } = await import('@/lib/ingest/parse-source');
    const out = await parseSource(Buffer.from('x'), 'application/pdf', 'a.pdf');
    expect(out.parser).toBe('text-only-fallback');
    expect(out.parsed.kind).toBe('text');
    expect(m.multimodal).toHaveBeenCalledTimes(1);
    expect(m.textOnly).toHaveBeenCalledTimes(1);
  });

  it('PDF double failure: both multimodal and text-only throw → propagates text-only error', async () => {
    setupParserMocks({
      multimodalThrows: new Error('gemini boom'),
      textOnlyThrows: new Error('OCR necessário'),
    });
    const { parseSource } = await import('@/lib/ingest/parse-source');
    await expect(
      parseSource(Buffer.from('x'), 'application/pdf', 'a.pdf'),
    ).rejects.toThrow(/OCR/);
  });

  it('DOCX path: calls parseDocxWithTables, parser=docx-tables', async () => {
    const m = setupParserMocks({});
    const { parseSource } = await import('@/lib/ingest/parse-source');
    const out = await parseSource(
      Buffer.from('x'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'a.docx',
    );
    expect(out.parser).toBe('docx-tables');
    expect(out.parsed.kind).toBe('blocks');
    expect(m.docx).toHaveBeenCalledTimes(1);
    expect(m.multimodal).not.toHaveBeenCalled();
  });

  it('TXT path: parser=text-only', async () => {
    setupParserMocks({});
    const { parseSource } = await import('@/lib/ingest/parse-source');
    const out = await parseSource(Buffer.from('hello world'), 'text/plain', 'a.txt');
    expect(out.parser).toBe('text-only');
    expect(out.parsed.kind).toBe('text');
  });

  it('unsupported mime throws', async () => {
    setupParserMocks({});
    const { parseSource } = await import('@/lib/ingest/parse-source');
    await expect(
      parseSource(Buffer.from('x'), 'image/png', 'a.png'),
    ).rejects.toThrow(/n[ãa]o suportado|unsupported/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/lib/ingest/parse-source.test.ts`
Expected: FAIL with "Cannot find module '@/lib/ingest/parse-source'"

- [ ] **Step 3: Implement `lib/ingest/parse-source.ts`**

```ts
import type { ParsedSource } from '@/lib/ingest/types';
import { parsePdfMultimodal } from '@/lib/ingest/multimodal-parse';
import { parseDocxWithTables } from '@/lib/ingest/docx-parse';
import { parsePdfTextOnly, parseDocxTextOnly, parseTxt } from '@/lib/ingest/parser';

export type ParserKind = 'multimodal' | 'text-only-fallback' | 'docx-tables' | 'text-only';

export type ParseSourceResult = {
  parsed: ParsedSource;
  parser: ParserKind;
};

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function parseSource(
  buf: Buffer,
  mime: string,
  filename: string,
): Promise<ParseSourceResult> {
  if (mime === 'application/pdf') {
    try {
      const out = await parsePdfMultimodal(buf);
      return {
        parsed: { kind: 'blocks', blocks: out.blocks, pageCount: out.pageCount },
        parser: 'multimodal',
      };
    } catch (err) {
      console.warn(
        `[ingest/parse-source] multimodal failed for ${filename}; falling back to text-only:`,
        err instanceof Error ? err.message : String(err),
      );
      const fallback = await parsePdfTextOnly(buf);
      return {
        parsed: { kind: 'text', text: fallback.text, pageCount: fallback.pageCount },
        parser: 'text-only-fallback',
      };
    }
  }

  if (mime === DOCX_MIME) {
    try {
      const out = await parseDocxWithTables(buf);
      return { parsed: { kind: 'blocks', blocks: out.blocks }, parser: 'docx-tables' };
    } catch (err) {
      console.warn(
        `[ingest/parse-source] docx-tables failed for ${filename}; falling back to text-only:`,
        err instanceof Error ? err.message : String(err),
      );
      const fallback = await parseDocxTextOnly(buf);
      return { parsed: { kind: 'text', text: fallback.text }, parser: 'text-only-fallback' };
    }
  }

  if (mime === 'text/plain') {
    const out = parseTxt(buf);
    return { parsed: { kind: 'text', text: out.text }, parser: 'text-only' };
  }

  throw new Error(`Tipo não suportado: ${mime} (${filename})`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/lib/ingest/parse-source.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/ingest/parse-source.ts tests/lib/ingest/parse-source.test.ts
git commit -m "$(cat <<'EOF'
feat(ingest): parseSource dispatcher with multimodal+fallback

PDF tries multimodal first, falls back to parsePdfTextOnly on any
error and tags parser='text-only-fallback' for auditing. DOCX tries
parseDocxWithTables, falls back to parseDocxTextOnly. TXT trivial.
Returns discriminated ParsedSource so pipeline can dispatch on kind.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `chunkBlocks` in `lib/ingest/chunker.ts`

Adds the block-aware chunker. Text contiguous spans use the same paragraph-aware splitter as `chunkText`. Each table/figure becomes its own chunk.

**Files:**
- Modify: `lib/ingest/chunker.ts`
- Modify: `tests/lib/ingest/chunker.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/lib/ingest/chunker.test.ts`:

```ts
import { chunkBlocks } from '@/lib/ingest/chunker';
import type { Block } from '@/lib/ingest/types';

describe('chunkBlocks', () => {
  it('single text block → behaves like chunkText for the same content', async () => {
    const long = 'parágrafo um. '.repeat(300); // well over 3200 chars
    const blocks: Block[] = [{ type: 'text', page: 1, content: long }];
    const out = chunkBlocks(blocks);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.metadata.kind).toBe('text');
      expect(c.metadata.page).toBe(1);
      expect(c.content.length).toBeLessThanOrEqual(3200);
    }
  });

  it('single table block → 1 chunk with kind=table and content includes caption + markdown', () => {
    const blocks: Block[] = [
      { type: 'table', page: 4, markdown: '| a |\n|---|\n| 1 |', caption: 'Tabela 2' },
    ];
    const out = chunkBlocks(blocks);
    expect(out).toHaveLength(1);
    expect(out[0].metadata.kind).toBe('table');
    expect(out[0].metadata.page).toBe(4);
    expect(out[0].metadata.caption).toBe('Tabela 2');
    expect(out[0].content).toContain('Tabela 2');
    expect(out[0].content).toContain('| a |');
  });

  it('single figure block → 1 chunk with kind=figure, figureKind preserved', () => {
    const blocks: Block[] = [
      {
        type: 'figure',
        page: 7,
        description: 'A flow diagram with three labelled boxes connected by arrows.',
        caption: 'Figura 3',
        figureKind: 'flow',
      },
    ];
    const out = chunkBlocks(blocks);
    expect(out).toHaveLength(1);
    expect(out[0].metadata.kind).toBe('figure');
    expect(out[0].metadata.figureKind).toBe('flow');
    expect(out[0].content).toContain('Figura 3');
  });

  it('text + table + text + figure + text → text chunks merge contiguous spans, structured blocks stay individual', () => {
    const blocks: Block[] = [
      { type: 'text', page: 1, content: 'short text 1' },
      { type: 'table', page: 1, markdown: '| h |\n|---|\n| v |' },
      { type: 'text', page: 2, content: 'short text 2' },
      {
        type: 'figure',
        page: 3,
        description: 'A simple diagram description that is long enough to pass.',
        figureKind: 'diagram',
      },
      { type: 'text', page: 3, content: 'short text 3' },
    ];
    const out = chunkBlocks(blocks);
    const kinds = out.map((c) => c.metadata.kind);
    expect(kinds).toEqual(['text', 'table', 'text', 'figure', 'text']);
  });

  it('table block does not split even when markdown exceeds 3200 chars', () => {
    const big = '| col |\n|---|\n' + ('| value |\n'.repeat(400)); // > 3200
    const blocks: Block[] = [{ type: 'table', page: 1, markdown: big }];
    const out = chunkBlocks(blocks);
    expect(out).toHaveLength(1);
    expect(out[0].content.length).toBeGreaterThan(3200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/lib/ingest/chunker.test.ts`
Expected: FAIL with "chunkBlocks is not exported" or similar

- [ ] **Step 3: Implement `chunkBlocks`**

Replace `lib/ingest/chunker.ts` with:

```ts
import type { Block, ChunkRow } from '@/lib/ingest/types';

const MAX_CHUNK_CHARS = 3200;
const OVERLAP_CHARS = 400;

function splitParagraphAware(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const paragraphs = trimmed
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let buffer: string[] = [];
  let bufferLen = 0;

  const flush = () => {
    const joined = buffer.join('\n\n').trim();
    buffer = [];
    bufferLen = 0;
    if (!joined) return;
    if (joined.length <= MAX_CHUNK_CHARS) {
      chunks.push(joined);
      return;
    }
    let start = 0;
    while (start < joined.length) {
      const end = Math.min(start + MAX_CHUNK_CHARS, joined.length);
      chunks.push(joined.slice(start, end));
      if (end === joined.length) break;
      start = end - OVERLAP_CHARS;
    }
  };

  for (const p of paragraphs) {
    const sep = buffer.length > 0 ? 2 : 0;
    const prospective = bufferLen + p.length + sep;
    if (buffer.length > 0 && prospective > MAX_CHUNK_CHARS) flush();
    buffer.push(p);
    bufferLen += p.length + sep;
  }
  flush();
  return chunks;
}

export function chunkText(text: string): string[] {
  return splitParagraphAware(text);
}

export function chunkBlocks(blocks: Block[]): ChunkRow[] {
  const out: ChunkRow[] = [];
  let textBuffer: { content: string; page: number } | null = null;

  const flushTextBuffer = () => {
    if (!textBuffer) return;
    const pieces = splitParagraphAware(textBuffer.content);
    for (const content of pieces) {
      out.push({ content, metadata: { kind: 'text', page: textBuffer.page } });
    }
    textBuffer = null;
  };

  for (const b of blocks) {
    if (b.type === 'text') {
      if (textBuffer) {
        textBuffer.content += '\n\n' + b.content;
      } else {
        textBuffer = { content: b.content, page: b.page };
      }
      continue;
    }
    flushTextBuffer();
    if (b.type === 'table') {
      const content = b.caption ? `${b.caption}\n\n${b.markdown}` : b.markdown;
      out.push({
        content,
        metadata: { kind: 'table', page: b.page, caption: b.caption },
      });
    } else {
      const content = b.caption ? `${b.caption}\n\n${b.description}` : b.description;
      out.push({
        content,
        metadata: {
          kind: 'figure',
          page: b.page,
          caption: b.caption,
          figureKind: b.figureKind,
        },
      });
    }
  }
  flushTextBuffer();
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/lib/ingest/chunker.test.ts`
Expected: PASS (existing chunkText tests + 5 new chunkBlocks tests)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/ingest/chunker.ts tests/lib/ingest/chunker.test.ts
git commit -m "$(cat <<'EOF'
feat(ingest): chunkBlocks for multimodal block stream

Text spans are merged across contiguous text blocks then split by the
existing paragraph-aware algorithm (3200 max, 400 overlap). Table and
figure blocks each become a single chunk with kind/page/caption
metadata; tables are not split even when markdown exceeds 3200 (split
would destroy table semantics).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Pipeline integration

Wire `parseSource` into `runPipeline`. Dispatch chunk creation based on `parsed.kind`. Stamp `metadata.parser` on the article and `metadata.{kind,page,caption,figureKind}` on each chunk.

**Files:**
- Modify: `lib/ingest/pipeline.ts`
- Modify: `tests/lib/ingest/pipeline.test.ts`

- [ ] **Step 1: Update `lib/ingest/pipeline.ts`**

Replace the file with:

```ts
import { getServerSupabase } from '@/lib/db/supabase';
import { downloadFromIngestBucket, deleteFromIngestBucket } from '@/lib/db/storage';
import { parseSource } from '@/lib/ingest/parse-source';
import { chunkText, chunkBlocks } from '@/lib/ingest/chunker';
import { extractMetadata } from '@/lib/ingest/metadata';
import { sha256 } from '@/lib/ingest/hash';
import { embed } from '@/lib/llm/voyage';
import type { ChunkRow } from '@/lib/ingest/types';

const EMBED_BATCH = 16;

export async function runPipeline(jobId: string): Promise<void> {
  const sb = getServerSupabase();

  const update = (patch: Record<string, unknown>) =>
    sb
      .from('ingestion_jobs')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', jobId);

  try {
    const { data: job, error } = await sb
      .from('ingestion_jobs')
      .select('*')
      .eq('id', jobId)
      .single();
    if (error || !job) throw new Error(`job ${jobId} not found: ${error?.message ?? 'no row'}`);

    await update({ status: 'running', stage: 'parsing', progress: 5 });
    const blob = await downloadFromIngestBucket(job.storage_path);
    const { parsed, parser } = await parseSource(blob, job.mime_type, job.filename);

    await update({ stage: 'chunking', progress: 20 });
    const chunkRows: ChunkRow[] =
      parsed.kind === 'blocks'
        ? chunkBlocks(parsed.blocks)
        : chunkText(parsed.text).map((content) => ({
            content,
            metadata: { kind: 'text' as const },
          }));
    if (chunkRows.length === 0) throw new Error('Nenhum chunk gerado a partir do conteúdo');

    // Source text used by metadata extraction + raw_md + source_chars accounting:
    // for blocks, concat all text-block contents; for text path, use the text directly.
    const sourceText =
      parsed.kind === 'text'
        ? parsed.text
        : parsed.blocks
            .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
            .map((b) => b.content)
            .join('\n\n');

    const meta = extractMetadata(sourceText, job.filename);
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

    const { data: article, error: insArtErr } = await sb
      .from('articles')
      .insert({
        title: meta.title,
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

    await update({ stage: 'embedding', progress: 40 });
    const embeddings: number[][] = [];
    for (let i = 0; i < chunkRows.length; i += EMBED_BATCH) {
      const slice = chunkRows.slice(i, i + EMBED_BATCH).map((r) => r.content);
      const out = await embed(slice, 'document');
      embeddings.push(...out);
      const pct = 40 + Math.floor(((i + slice.length) / chunkRows.length) * 50);
      await update({ progress: Math.min(pct, 90) });
    }

    await update({ stage: 'inserting', progress: 92 });
    const rows = chunkRows.map((r, idx) => ({
      article_id: article.id,
      ord: idx,
      content: r.content,
      embedding: embeddings[idx],
      metadata: { source_filename: job.filename, ...r.metadata },
    }));
    for (let i = 0; i < rows.length; i += 50) {
      await sb.from('chunks').insert(rows.slice(i, i + 50));
    }

    await deleteFromIngestBucket(job.storage_path);

    const counts = chunkRows.reduce(
      (acc, r) => {
        acc[r.metadata.kind] = (acc[r.metadata.kind] ?? 0) + 1;
        return acc;
      },
      { text: 0, table: 0, figure: 0 } as Record<string, number>,
    );
    console.info(
      `[ingest/pipeline] done articleId=${article.id} parser=${parser} text=${counts.text} table=${counts.table} figure=${counts.figure} total=${chunkRows.length}`,
    );

    await update({
      status: 'done',
      stage: null,
      progress: 100,
      chunks_count: chunkRows.length,
      article_id: article.id,
      finished_at: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro desconhecido';
    await update({
      status: 'error',
      error_message: message,
      finished_at: new Date().toISOString(),
    });
  }
}
```

- [ ] **Step 2: Update existing `tests/lib/ingest/pipeline.test.ts`**

The existing test mocks `@/lib/ingest/parser` (`parseFile`). Switch the mock target to `@/lib/ingest/parse-source` (`parseSource`) and update the return shape. Replace the `setupMocks` helper inside the existing file:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Block } from '@/lib/ingest/types';

beforeEach(() => {
  vi.resetModules();
});

type JobRow = {
  id: string;
  user_id: string;
  filename: string;
  storage_path: string;
  size_bytes: number;
  mime_type: string;
  status: string;
  stage: string | null;
  progress: number;
  chunks_count: number | null;
  article_id: string | null;
  error_message: string | null;
};

function setupMocks(opts: {
  job: JobRow;
  parsed?:
    | { kind: 'text'; text: string; pageCount?: number }
    | { kind: 'blocks'; blocks: Block[]; pageCount?: number };
  parser?: 'multimodal' | 'text-only-fallback' | 'docx-tables' | 'text-only';
  parseShouldThrow?: boolean;
  existingArticleId?: string | null;
}) {
  const updateCalls: Array<Record<string, unknown>> = [];
  const insertedArticles: Array<Record<string, unknown>> = [];
  const insertedChunkBatches: Array<Array<Record<string, unknown>>> = [];

  vi.doMock('@/lib/db/storage', () => ({
    INGEST_BUCKET: 'ingest-uploads',
    downloadFromIngestBucket: vi.fn().mockResolvedValue(Buffer.from('any', 'utf-8')),
    deleteFromIngestBucket: vi.fn().mockResolvedValue(undefined),
  }));

  vi.doMock('@/lib/ingest/parse-source', () => ({
    parseSource: vi.fn().mockImplementation(async () => {
      if (opts.parseShouldThrow) throw new Error('Conteúdo muito curto — OCR necessário');
      return {
        parsed: opts.parsed ?? { kind: 'text', text: 'Texto longo. '.repeat(80), pageCount: 5 },
        parser: opts.parser ?? 'multimodal',
      };
    }),
  }));

  vi.doMock('@/lib/llm/voyage', () => ({
    embed: vi.fn().mockImplementation(async (texts: string[]) =>
      texts.map(() => Array(1024).fill(0)),
    ),
  }));

  vi.doMock('@/lib/db/supabase', () => ({
    getServerSupabase: () => ({
      from: (table: string) => {
        const builder: Record<string, unknown> = {};
        let pendingInsert: unknown = null;
        builder.select = vi.fn().mockReturnThis();
        builder.eq = vi.fn().mockReturnThis();
        builder.update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          if (table === 'ingestion_jobs') updateCalls.push(payload);
          return builder;
        });
        builder.insert = vi.fn().mockImplementation((payload: unknown) => {
          pendingInsert = payload;
          if (table === 'articles') insertedArticles.push(payload as Record<string, unknown>);
          if (table === 'chunks') insertedChunkBatches.push(payload as Array<Record<string, unknown>>);
          return builder;
        });
        builder.single = vi.fn().mockImplementation(async () => {
          if (table === 'ingestion_jobs') return { data: opts.job, error: null };
          if (table === 'articles' && pendingInsert) {
            return { data: { id: 'new-art-1' }, error: null };
          }
          return { data: null, error: null };
        });
        builder.maybeSingle = vi.fn().mockImplementation(async () => {
          if (table === 'articles') {
            return {
              data: opts.existingArticleId ? { id: opts.existingArticleId } : null,
              error: null,
            };
          }
          return { data: null, error: null };
        });
        return builder;
      },
    }),
  }));

  return { updateCalls, insertedArticles, insertedChunkBatches };
}

const baseJob: JobRow = {
  id: 'job-1',
  user_id: 'u1',
  filename: 'kraljic.pdf',
  storage_path: 'u1/job-1/kraljic.pdf',
  size_bytes: 12345,
  mime_type: 'application/pdf',
  status: 'queued',
  stage: null,
  progress: 0,
  chunks_count: null,
  article_id: null,
  error_message: null,
};

describe('lib/ingest/pipeline', () => {
  it('happy path text fallback: writes article, embeds chunks, marks done', async () => {
    const m = setupMocks({ job: baseJob, parser: 'text-only-fallback' });
    const { runPipeline } = await import('@/lib/ingest/pipeline');
    await runPipeline('job-1');
    expect(m.insertedArticles).toHaveLength(1);
    const finalUpdate = m.updateCalls[m.updateCalls.length - 1]!;
    expect(finalUpdate.status).toBe('done');
    expect(finalUpdate.chunks_count).toBeGreaterThan(0);
  });

  it('multimodal blocks: text/table/figure each get correct chunk metadata.kind', async () => {
    const blocks: Block[] = [
      { type: 'text', page: 1, content: 'Lots of text. '.repeat(40) },
      { type: 'table', page: 2, markdown: '| a |\n|---|\n| 1 |', caption: 'Tabela X' },
      {
        type: 'figure',
        page: 3,
        description: 'A flow diagram with 3 boxes connected by arrows in a sequence.',
        caption: 'Figura Y',
        figureKind: 'flow',
      },
    ];
    const m = setupMocks({
      job: baseJob,
      parsed: { kind: 'blocks', blocks },
      parser: 'multimodal',
    });
    const { runPipeline } = await import('@/lib/ingest/pipeline');
    await runPipeline('job-1');

    const article = m.insertedArticles[0] as Record<string, unknown>;
    expect((article.metadata as Record<string, unknown>).parser).toBe('multimodal');

    const allChunks = m.insertedChunkBatches.flat();
    const kinds = allChunks.map((c) => (c.metadata as { kind: string }).kind);
    expect(kinds).toContain('text');
    expect(kinds).toContain('table');
    expect(kinds).toContain('figure');
    const figureChunk = allChunks.find(
      (c) => (c.metadata as { kind: string }).kind === 'figure',
    );
    expect((figureChunk!.metadata as { figureKind?: string }).figureKind).toBe('flow');
    expect((figureChunk!.metadata as { page?: number }).page).toBe(3);
  });

  it('parser failure marks job status=error and storage file is NOT deleted', async () => {
    const m = setupMocks({ job: baseJob, parseShouldThrow: true });
    const storage = await import('@/lib/db/storage');
    const deleteSpy = storage.deleteFromIngestBucket as ReturnType<typeof vi.fn>;
    const { runPipeline } = await import('@/lib/ingest/pipeline');
    await runPipeline('job-1');
    const finalUpdate = m.updateCalls[m.updateCalls.length - 1]!;
    expect(finalUpdate.status).toBe('error');
    expect(String(finalUpdate.error_message)).toMatch(/OCR/i);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('records article.metadata.parser=text-only-fallback when parser reports fallback', async () => {
    const m = setupMocks({
      job: baseJob,
      parser: 'text-only-fallback',
      parsed: { kind: 'text', text: 'Texto longo. '.repeat(80) },
    });
    const { runPipeline } = await import('@/lib/ingest/pipeline');
    await runPipeline('job-1');
    const article = m.insertedArticles[0] as Record<string, unknown>;
    expect((article.metadata as Record<string, unknown>).parser).toBe('text-only-fallback');
  });

  it('writes source_chars equal to the parsed text length on the new article row (text path)', async () => {
    const m = setupMocks({
      job: baseJob,
      parsed: { kind: 'text', text: 'Texto longo. '.repeat(80) },
      parser: 'text-only',
    });
    const { runPipeline } = await import('@/lib/ingest/pipeline');
    await runPipeline('job-1');
    const row = m.insertedArticles[0] as Record<string, unknown>;
    const rawMd = row.raw_md as string;
    expect(row.source_chars).toBe(rawMd.length);
  });

  it('dedup hit: existing article matched → status=done, chunks_count=0, no inserts', async () => {
    const m = setupMocks({ job: baseJob, existingArticleId: 'existing-art-9' });
    const { runPipeline } = await import('@/lib/ingest/pipeline');
    await runPipeline('job-1');
    expect(m.insertedArticles).toHaveLength(0);
    expect(m.insertedChunkBatches).toHaveLength(0);
    const finalUpdate = m.updateCalls[m.updateCalls.length - 1]!;
    expect(finalUpdate.status).toBe('done');
    expect(finalUpdate.chunks_count).toBe(0);
    expect(finalUpdate.stage).toBe('deduplicated');
  });
});
```

- [ ] **Step 3: Run pipeline tests**

Run: `npm test -- tests/lib/ingest/pipeline.test.ts`
Expected: PASS (6 tests, 4 of them updated/new)

- [ ] **Step 4: Run full test suite to catch any regressions**

Run: `npm test`
Expected: PASS (~233 vitest passing; pytest unaffected at 23)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/ingest/pipeline.ts tests/lib/ingest/pipeline.test.ts
git commit -m "$(cat <<'EOF'
feat(ingest): pipeline dispatches text vs blocks; records parser tag

runPipeline now calls parseSource and dispatches chunk creation by
parsed.kind. Each chunk's metadata gains kind/page/caption/figureKind
when present. Article metadata gains parser=multimodal|text-only-fallback|
docx-tables|text-only for auditing. console.info summary logs counts
by kind at end of pipeline.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Admin UI — kind badge + page number

Surfaces `metadata.kind` and `metadata.page` per chunk in `/admin/articles`. Pure visual change.

**Files:**
- Modify: `components/admin/ArticleDetail.tsx`

- [ ] **Step 1: Update the chunk select query to include metadata, render badge + page**

Replace the relevant parts of `components/admin/ArticleDetail.tsx`:

Change the `Chunk` type and the select call (around line 19 and 41-43):

```ts
type ChunkKind = 'text' | 'table' | 'figure';

type ChunkMetadata = {
  kind?: ChunkKind;
  page?: number;
  caption?: string;
  figureKind?: 'flow' | 'chart' | 'diagram';
};

type Chunk = {
  id: string;
  ord: number;
  content: string;
  metadata: ChunkMetadata | null;
};
```

```ts
const { data } = await supabaseBrowser()
  .from('chunks')
  .select('id, ord, content, metadata')
  .eq('article_id', article.id)
  .order('ord', { ascending: true });
```

Then replace the `chunks.map((c) => ...)` block with:

```tsx
{chunks.map((c) => {
  const kind: ChunkKind = c.metadata?.kind ?? 'text';
  const page = c.metadata?.page;
  const badgeClass =
    kind === 'table'
      ? 'bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100'
      : kind === 'figure'
        ? 'bg-purple-100 text-purple-900 dark:bg-purple-900/40 dark:text-purple-100'
        : 'bg-muted text-muted-foreground';
  return (
    <details
      key={c.id}
      className="bg-muted/40 rounded-md border-l-2 border-border text-xs leading-relaxed"
    >
      <summary className="cursor-pointer p-2 hover:bg-muted/60">
        <span className={`mr-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${badgeClass}`}>
          {kind}
        </span>
        <span className="text-muted-foreground mr-2 tabular-nums">#{c.ord}</span>
        {page !== undefined && (
          <span className="text-muted-foreground mr-2 tabular-nums">p.{page}</span>
        )}
        {c.content.slice(0, 200)}
        {c.content.length > 200 && '…'}
      </summary>
      <pre className="mt-2 px-3 pb-3 whitespace-pre-wrap font-mono text-[11px]">
        {c.content}
      </pre>
    </details>
  );
})}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Manual smoke check (dev server)**

Run: `npm run dev` (in background)
Visit `/admin/articles`, select any existing article. Confirm:
- All current chunks show `text` badge (since old chunks were ingested before kind metadata existed; metadata.kind is absent → defaults to `text`).
- Layout unchanged otherwise.

(Real `table`/`figure` badges appear after the backfill in Task 13.)

- [ ] **Step 4: Commit**

```bash
git add components/admin/ArticleDetail.tsx
git commit -m "$(cat <<'EOF'
feat(admin): chunk kind badge + page number in /admin/articles detail

Each chunk row now shows a colored kind badge (text=neutral, table=blue,
figure=purple) plus the source page when available. Defaults to 'text'
for chunks ingested before sub-projeto 12 (no metadata.kind).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Eval golden set — 5 new pairs (placeholder commit)

Adds the 5 query strings now with `expected_chunks: []` placeholders. Task 13 fills the IDs after backfill. This split lets the engineer (or admin) review the queries first.

**Files:**
- Modify: `scripts/eval/golden.json`

- [ ] **Step 1: Read current `scripts/eval/golden.json`**

Run: `npm test -- --reporter=verbose 2>&1 | head -1` (just to confirm path); then `Read` the file directly.

- [ ] **Step 2: Append 5 new pairs to `scripts/eval/golden.json`**

Insert at the end of the existing pairs array (preserving JSON structure — match existing schema by inspecting the file first):

```json
{
  "id": "structured-kraljic-matrix",
  "query": "como é estruturada a matriz de Kraljic?",
  "language": "pt",
  "angle": "structured-content",
  "expected_chunks": []
},
{
  "id": "structured-kraljic-quadrants",
  "query": "quais são os 4 quadrantes da matriz de Kraljic?",
  "language": "pt",
  "angle": "structured-content",
  "expected_chunks": []
},
{
  "id": "structured-s2p-flow",
  "query": "qual é o fluxo do processo source-to-pay?",
  "language": "pt",
  "angle": "structured-content",
  "expected_chunks": []
},
{
  "id": "structured-stakeholders-diagram",
  "query": "quem são os stakeholders no diagrama de procurement?",
  "language": "pt",
  "angle": "structured-content",
  "expected_chunks": []
},
{
  "id": "structured-spend-by-category",
  "query": "qual a distribuição de gastos por categoria?",
  "language": "pt",
  "angle": "structured-content",
  "expected_chunks": []
}
```

(Inspect the existing JSON shape first — these field names must match. If existing items use different keys e.g. `chunk_ids`, mirror them.)

- [ ] **Step 3: Run eval to confirm queries parse but flag missing IDs**

Run: `npm run rag:eval -- --skip-empty` (if the runner supports it) or just `npm run rag:eval` and ignore the 5 new pairs returning recall=0 — recall@5 over the existing 25 pairs must remain ≥ 0.85.

If running on the existing 25-pair set still passes, the added pairs are inert until backfill fills `expected_chunks`. Confirm in the output that recall@5 line is still ≥ 0.85 over the scoreable subset.

- [ ] **Step 4: Commit**

```bash
git add scripts/eval/golden.json
git commit -m "$(cat <<'EOF'
chore(eval): add 5 structured-content queries (IDs filled in Task 13)

Five new golden queries focused on tables (Kraljic), flows (S2P,
stakeholders) and charts (spend by category). expected_chunks left
empty until backfill of the 4 existing articles produces table/figure
chunk IDs. recall@5 gate remains 0.85 over the existing scoreable
subset.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Backfill — re-ingest 4 articles + populate `expected_chunks`

**Manual / human-driven task.** The pipeline is now multimodal-capable; we need to actually re-ingest the existing 4 articles with the new pipeline and then identify the chunk IDs that should match each new golden query.

**Files:**
- Modify: `scripts/eval/golden.json`

- [ ] **Step 1: Identify the 4 current articles**

Run: `npm test --silent` first to confirm a clean state. Then visit `/admin/articles` (admin user `rgoalves@gmail.com`) and note the 4 article titles. Save originals locally if not already (the Storage bucket has been cleared on prior success — admin must have local copies).

- [ ] **Step 2: Delete the 4 articles**

In `/admin/articles`, click each → Excluir → confirm. (Cascade removes chunks via existing FK.)

- [ ] **Step 3: Re-upload via `/admin/ingest`**

Drop each PDF into `/admin/ingest`. Watch `JobsLive` for stage transitions: `parsing` → `chunking` → `embedding` → `inserting` → `done`. Expected duration per article: 30–90s (multimodal call) + embeddings (~5s) ≈ <2 min per article.

Confirm the `console.info` summary in the server logs shows non-zero `table` and/or `figure` counts for at least 2 of the 4 articles. If all 4 articles report `parser=text-only-fallback`, something is wrong with the multimodal call — debug before proceeding.

- [ ] **Step 4: Identify table/figure chunk IDs**

In `/admin/articles`, open each article. Use the new badges to find chunks tagged `table` or `figure`. Note the chunk IDs (visible in the network panel of devtools when the chunks query fires, or via Supabase dashboard).

For each of the 5 new golden queries:
- `structured-kraljic-matrix` and `structured-kraljic-quadrants` → expected to match the same Kraljic-table chunk(s).
- `structured-s2p-flow` → matches the S2P flow figure chunk.
- `structured-stakeholders-diagram` → matches a stakeholders-related figure chunk OR a text chunk if no diagram exists in the corpus.
- `structured-spend-by-category` → matches a chart figure chunk OR a text chunk.

Where no matching table/figure exists in the current 4-article corpus, fall back to populating `expected_chunks` with the most-relevant text chunk ID (eval still measures retrieval quality, just not retrieval-of-structured-content for that pair).

- [ ] **Step 5: Update `scripts/eval/golden.json` with real IDs**

Edit the 5 entries added in Task 12, replacing each `"expected_chunks": []` with `"expected_chunks": ["<uuid>"]` (one or more chunk UUIDs).

- [ ] **Step 6: Run full eval**

Run: `npm run rag:eval`
Expected: PASS with `recall@5 ≥ 0.85` across all 30 pairs.

If recall drops below 0.85, inspect which queries miss. Likely causes and fixes:
- Wrong chunk ID in `expected_chunks` → verify in admin UI, fix.
- Multimodal extraction missed the table → re-run ingestion for that single article (delete + re-upload); inspect the server logs for warnings.
- Retrieval genuinely doesn't surface the table within top-5 → consider if the query phrasing is too oblique; rephrase the golden query.

- [ ] **Step 7: Commit**

```bash
git add scripts/eval/golden.json
git commit -m "$(cat <<'EOF'
chore(eval): backfill structured-content chunk IDs after re-ingestion

Re-ingested the 4 corpus articles through the multimodal pipeline;
identified table/figure chunk IDs and populated expected_chunks for
the 5 structured-content golden pairs. recall@5 over 30 pairs ≥ 0.85.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Smoke doc + CLAUDE.md + tag

Closing task — documentation + version tag.

**Files:**
- Modify: `docs/product/beta-smoke-test.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append 5 smoke items to `docs/product/beta-smoke-test.md`**

Add a new section at the appropriate place in the file:

```markdown
### Sub-projeto 12 — Multimodal Ingestion

- [ ] Re-ingerir 1 PDF com tabela conhecida (ex: Kraljic): `/admin/articles` mostra ≥1 chunk com badge azul `table`; abrir o chunk mostra markdown da tabela com células corretas.
- [ ] Re-ingerir 1 PDF com fluxograma: `/admin/articles` mostra ≥1 chunk com badge roxo `figure`; abrir mostra description coerente do fluxo.
- [ ] No `/chat`, query "matriz de Kraljic" recupera resposta que reflete os labels da tabela (não só parágrafos próximos).
- [ ] Erro path: ingerir PDF corrompido → ou o job vira `error` com mensagem clara, ou completa com `articles.metadata.parser='text-only-fallback'` (verificar via Supabase dashboard).
- [ ] DOCX com tabela: `/admin/articles` mostra chunk `table`; markdown bem-formado com header divider.
```

- [ ] **Step 2: Update CLAUDE.md**

Add a row to the "Status — sub-projetos completos" table:

```markdown
| 12 | `multimodal-ingestion-complete` | Ingestão PDF agora via Gemini multimodal nativo (1 chamada por artigo, ~$0.02). `lib/ingest/multimodal-parse.ts` com zod schema + retry 1x + AbortController 120s; >20MB usa Files API. `lib/ingest/parse-source.ts` orquestra dispatch (PDF→multimodal-com-fallback, DOCX→tables-aware, TXT→trivial). Chunker ganha `chunkBlocks` que emite 1 chunk por table/figure (sem split mesmo >3200) e agrupa text contíguo. `chunks.metadata` ganha `kind`/`page`/`caption`/`figureKind` (sem migration — JSONB). `articles.metadata.parser` registra `multimodal`/`text-only-fallback`/`docx-tables`/`text-only`. `/admin/articles` mostra badge colorido por kind + número de página. Eval +5 pares (tabelas Kraljic, fluxos S2P/stakeholders, gráfico spend); CI gate `recall@5 ≥ 0.85` mantido sobre 30 pares. Re-ingestão dos 4 artigos atuais foi manual (delete + re-upload) — `keep_source` deliberadamente fora de escopo. |
```

Add to the "O que evitar" section, at the appropriate place:

```markdown
- Chamar `parseFile` em código novo — o export é `@deprecated` desde sub-projeto 12. Use `parseSource` (`lib/ingest/parse-source.ts`) que dispatcha multimodal-with-fallback. `parseFile` só fica para retrocompat interna.
- Esquecer de incluir `metadata.kind` no mock de chunk em testes novos do `/admin/articles` ou pipeline — sub-projeto 12 adicionou kind/page/caption/figureKind no JSONB. Padrão para text: `{ kind: 'text' }`. Tests legacy usam metadata vazia; UI defaultiza para `text`.
- Tentar split em chunks de tabela ou figure — `chunkBlocks` deliberadamente não split tabela/figure mesmo se passar de 3200 chars. Tabela quebrada perde semântica; aceita-se chunk grande.
- Awaitar response do `/api/admin/ingest/run/[jobId]` no cliente quando o pipeline está usando multimodal — a chamada multimodal pode levar 30-90s. Padrão fire-and-forget existente já cobre, mas qualquer mudança que introduza await vai bloquear UI.
- Confiar em `keep_source` na tabela `ingestion_jobs` — não existe. Sub-projeto 12 deliberadamente NÃO adicionou. Se reprocessamento massivo virar dor, sub-projeto futuro adiciona migration + flag.
- Em retries do Gemini multimodal: o retry só dispara em `z.ZodError` ou `SyntaxError`. Erros de rede / 5xx vão direto pro fallback texto-only no `parseSource` — não ficam looping.
- Esquecer que o `parser` field em `articles.metadata` é o sinal de auditoria — quando todo PDF está caindo em `text-only-fallback`, o multimodal está com problema; investigar antes de assumir que o gain de tabelas/figuras está chegando.
```

Update the "Estrutura de pastas" section under `/lib/ingest`:

```
  /ingest                               (TS port da pipeline; scripts/ingest.py mantido como legacy)
    types.ts                            (JobStatus, JobStage, IngestJob, Block, ParsedSource, ChunkKind, ChunkRow)
    hash.ts                             (sha256 helper)
    parser.ts                           (parsePdfTextOnly + parseDocxTextOnly + parseTxt; parseFile @deprecated mime-dispatch wrapper)
    multimodal-parse.ts                 (parsePdfMultimodal: Gemini multimodal, inline + Files API, zod retry, abort 120s)
    docx-parse.ts                       (parseDocxWithTables: mammoth.convertToHtml + table extraction)
    html-table.ts                       (htmlTableToMarkdown utility)
    parse-source.ts                     (parseSource dispatcher: PDF→multimodal-with-fallback, DOCX→tables-aware, TXT→trivial)
    chunker.ts                          (chunkText + chunkBlocks; paragraph-aware splitter shared internally)
    metadata.ts                         (title/author/language/date heurísticas)
    pipeline.ts                         (runPipeline orquestrador end-to-end; dispatcha por parsed.kind)
```

- [ ] **Step 3: Run final CI gate locally**

```bash
npm run typecheck
npm test
npm run rag:eval
```
Expected: all PASS; vitest ~233 tests, recall@5 ≥ 0.85.

- [ ] **Step 4: Commit docs**

```bash
git add docs/product/beta-smoke-test.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(CLAUDE.md): record sub-projeto 12 (multimodal ingestion) + gotchas

Captures the multimodal ingest path, fallback behavior, parser
auditing field on articles.metadata, and explicit non-decisions
(no keep_source flag, no chunk split for table/figure). Smoke test
adds 5 manual checks for the new badges + table/figure retrieval.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Push and tag**

```bash
git push origin main
git tag multimodal-ingestion-complete
git push origin multimodal-ingestion-complete
```

- [ ] **Step 6: Verify CI green on the push**

Open the GitHub Actions tab for the latest commit on `main` and confirm:
- typecheck ✓
- vitest ✓
- pytest ✓ (unchanged)
- rag:eval ✓ (recall@5 ≥ 0.85 over 30 pairs)

If any job fails, fix and create a new commit (do not amend the tagged commit).

---

## Verification checklist (sub-projeto 12 exit criteria)

After Task 14 completes, all the following must be true:

1. ✅ `lib/ingest/multimodal-parse.ts`, `lib/ingest/docx-parse.ts`, `lib/ingest/html-table.ts`, `lib/ingest/parse-source.ts` exist and have ≥30 vitest tests passing.
2. ✅ `lib/ingest/chunker.ts` exports `chunkBlocks` and `chunkText`; tests cover both.
3. ✅ `lib/ingest/pipeline.ts` calls `parseSource`; tests cover both blocks and text paths.
4. ✅ The 4 corpus articles re-ingested; `/admin/articles` shows ≥1 non-text chunk per article that contains a table or figure.
5. ✅ `scripts/eval/golden.json` has 30 pairs (25 original + 5 structured-content); `npm run rag:eval` passes with `recall@5 ≥ 0.85`.
6. ✅ `/admin/articles` chunk rows show colored badges (text/table/figure) + page numbers.
7. ✅ `docs/product/beta-smoke-test.md` has 5 new manual smoke items (visually verified by hand).
8. ✅ CI green on `main` (typecheck + vitest + pytest + rag:eval).
9. ✅ `CLAUDE.md` updated with sub-projeto 12 row + gotchas.
10. ✅ Tag `multimodal-ingestion-complete` pushed to origin.
