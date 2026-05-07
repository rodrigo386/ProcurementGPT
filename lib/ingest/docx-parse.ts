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

  // If everything came out empty or too short, treat as bad input.
  const totalLen = blocks.reduce(
    (n, b) => {
      if (b.type === 'text') return n + b.content.length;
      if (b.type === 'table') return n + b.markdown.length;
      // FigureBlock
      return n + b.description.length;
    },
    0,
  );
  if (blocks.length === 0 || totalLen < MIN_TEXT_CHARS) {
    throw new Error(
      `Conteúdo DOCX vazio ou muito curto após parsing (total ${totalLen} chars em ${blocks.length} blocos)`,
    );
  }
  return { blocks };
}
