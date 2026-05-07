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
    mime ===
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return parseDocxTextOnly(buf);
  }
  if (mime === 'text/plain') return parseTxt(buf);
  throw new Error(`Tipo não suportado: ${mime} (${filename})`);
}
