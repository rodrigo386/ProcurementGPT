export type ParsedFile = { text: string; pageCount?: number };

export async function parseFile(
  buf: Buffer,
  mime: string,
  filename: string,
): Promise<ParsedFile> {
  let text: string;
  let pageCount: number | undefined;

  if (mime === 'application/pdf') {
    // Dynamic import: pdf-parse runs a debug self-test at import-time when
    // imported at module top-level — the dynamic form avoids that pitfall.
    const pdfParse = (await import('pdf-parse')).default;
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
  const cleaned = text.replace(/\x00/g, '').replace(/\r\n/g, '\n');
  if (cleaned.trim().length < 500) {
    throw new Error(
      'Conteúdo muito curto — PDF parece escaneado / OCR necessário (texto extraído < 500 caracteres)',
    );
  }
  return { text: cleaned, pageCount };
}
