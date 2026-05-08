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
    } catch (mmErr) {
      const mmMsg = mmErr instanceof Error ? mmErr.message : String(mmErr);
      console.warn(
        `[ingest/parse-source] multimodal failed for ${filename}; falling back to text-only:`,
        mmMsg,
      );
      try {
        const fallback = await parsePdfTextOnly(buf);
        return {
          parsed: { kind: 'text', text: fallback.text, pageCount: fallback.pageCount },
          parser: 'text-only-fallback',
        };
      } catch (textErr) {
        const textMsg = textErr instanceof Error ? textErr.message : String(textErr);
        // Both paths failed — surface BOTH errors so the user sees the actual
        // multimodal failure (which is usually the load-bearing one) instead of
        // just the text-only guard. The text-only guard fires for image-only
        // PDFs as a downstream symptom, not as the root cause.
        throw new Error(
          `${textMsg} | Multimodal também falhou: ${mmMsg}`,
        );
      }
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
