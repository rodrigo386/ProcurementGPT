import { cleanExtractedText } from '@/lib/ingest/clean';

export type ParsedFile = { text: string; pageCount?: number };

export async function parseFile(
  buf: Buffer,
  mime: string,
  filename: string,
): Promise<ParsedFile> {
  let text: string;
  let pageCount: number | undefined;

  if (mime === 'application/pdf') {
    // pdf-parse@1.1.1 runs a debug self-test at module load when `module.parent`
    // is null — it tries to read 'test/data/05-versions-space.pdf' (which doesn't
    // exist in our project) and throws ENOENT. Dynamic import alone doesn't fix
    // this — only importing the inner file 'pdf-parse/lib/pdf-parse.js' bypasses
    // the index.js self-test wrapper.
    // @ts-expect-error — no types for the inner path; shape matches pdf-parse default export.
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default as
      (data: Buffer) => Promise<{ text: string; numpages: number }>;
    const data = await pdfParse(buf);
    text = data.text;
    pageCount = data.numpages;
  } else if (
    mime ===
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer: buf });
    text = value;
  } else if (mime === 'text/plain') {
    text = buf.toString('utf-8');
  } else {
    throw new Error(`Tipo não suportado: ${mime} (${filename})`);
  }

  // Strip null bytes (corrupted PDFs) and normalize line endings; do NOT strip spaces.
  const normalized = text.replace(/\x00/g, '').replace(/\r\n/g, '\n');
  // For PDFs, strip per-page headers/footers/watermarks/TOC noise. Other
  // formats are passed through cleanExtractedText too — its rules are safe
  // (the repetition threshold won't match anything in a clean DOCX/TXT).
  const cleaned = cleanExtractedText(normalized);
  if (cleaned.trim().length < 500) {
    throw new Error(
      'Conteúdo muito curto — PDF parece escaneado / OCR necessário (texto extraído < 500 caracteres)',
    );
  }
  return { text: cleaned, pageCount };
}
