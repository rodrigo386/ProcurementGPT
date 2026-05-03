// Post-extraction cleaner for PDF-parsed text. pdf-parse leaks page headers,
// footers, watermarks (CPF blocks), TOC dot-leaders, page numbers, and runs
// of blank lines from PDF layout. These consume embedding budget without
// adding signal. Strip them before chunking.

const REPETITION_THRESHOLD = 5; // lines appearing this many times are noise (headers/footers/watermarks)

const TOC_DOT_LEADER_RE = /\.{4,}\s*\d+\s*$/;
const STANDALONE_NUMBER_RE = /^\s*\d{1,4}\s*$/;

// Per-page footer variants. Page number varies, so the repetition detector
// doesn't catch them — use shape-based regexes instead.
const PAGE_X_OF_Y_RE = /\bp[áa]?g?(?:ina)?\.?\s*\d+\s*(?:de|of|\/)\s*\d+\b/i;
// Bare-number range like "p. 2 de 125" without the "página" prefix.
const SHORT_PAGE_REF_RE = /^\s*(?:p\.?|page|página)\s*\d+\s*(?:de|of|\/)\s*\d+\s*$/i;

export function cleanExtractedText(text: string): string {
  // 1. Strip form feed and other layout control chars.
  let working = text.replace(/\f/g, '\n');

  // 2. Tally line frequencies (trimmed). A line repeating ≥ THRESHOLD times
  //    is a per-page header/footer/watermark — drop every occurrence.
  const lines = working.split('\n');
  const freq = new Map<string, number>();
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    freq.set(trimmed, (freq.get(trimmed) ?? 0) + 1);
  }
  const noisyLines = new Set<string>();
  for (const [line, n] of freq) {
    if (n >= REPETITION_THRESHOLD) noisyLines.add(line);
  }

  // 3. Filter out noisy / TOC / standalone-page-number / page-X-of-Y lines.
  const filtered: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed && noisyLines.has(trimmed)) continue;
    if (trimmed && TOC_DOT_LEADER_RE.test(raw)) continue;
    if (trimmed && STANDALONE_NUMBER_RE.test(raw)) continue;
    if (trimmed && SHORT_PAGE_REF_RE.test(raw)) continue;
    if (trimmed && PAGE_X_OF_Y_RE.test(raw)) continue;
    filtered.push(raw);
  }
  working = filtered.join('\n');

  // 4. Collapse any run of 3+ newlines (with possible whitespace between)
  //    into exactly two newlines (one paragraph separator).
  working = working.replace(/(?:[ \t]*\n[ \t]*){3,}/g, '\n\n');

  return working.trim();
}
