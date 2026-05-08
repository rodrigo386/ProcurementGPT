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

async function setupMocks(opts: {
  job: JobRow;
  parsed?:
    | { kind: 'text'; text: string; pageCount?: number }
    | { kind: 'blocks'; blocks: Block[]; pageCount?: number };
  parser?: 'multimodal' | 'text-only-fallback' | 'docx-tables' | 'text-only';
  parseShouldThrow?: boolean;
  existingArticleId?: string | null;
  classifyTitle?: string;
  classifyTheme?: string;
  classifySummary?: string;
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

  vi.doMock('@/lib/ingest/classify-content', () => ({
    classifyContent: vi.fn().mockImplementation(async () => ({
      title: opts.classifyTitle ?? 'A meaningful title from LLM',
      theme: opts.classifyTheme ?? 'Outros',
      summary: opts.classifySummary ?? 'one-line summary',
    })),
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

  const classifyContentMod = await import('@/lib/ingest/classify-content');
  return {
    updateCalls,
    insertedArticles,
    insertedChunkBatches,
    classifyContent: classifyContentMod.classifyContent as ReturnType<typeof vi.fn>,
  };
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
    const m = await setupMocks({ job: baseJob, parser: 'text-only-fallback' });
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
    const m = await setupMocks({
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
    const m = await setupMocks({ job: baseJob, parseShouldThrow: true });
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
    const m = await setupMocks({
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
    const m = await setupMocks({
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
    const m = await setupMocks({ job: baseJob, existingArticleId: 'existing-art-9' });
    const { runPipeline } = await import('@/lib/ingest/pipeline');
    await runPipeline('job-1');
    expect(m.insertedArticles).toHaveLength(0);
    expect(m.insertedChunkBatches).toHaveLength(0);
    const finalUpdate = m.updateCalls[m.updateCalls.length - 1]!;
    expect(finalUpdate.status).toBe('done');
    expect(finalUpdate.chunks_count).toBe(0);
    expect(finalUpdate.stage).toBe('deduplicated');
  });

  it('uses classifyContent.title/theme/summary on the article insert (dedup miss)', async () => {
    const m = await setupMocks({
      job: baseJob,
      classifyTitle: 'Aplicação prática da matriz de Kraljic',
      classifyTheme: 'Kraljic',
      classifySummary: 'Caso aplicado a varejo de alimentos',
    });
    const { runPipeline } = await import('@/lib/ingest/pipeline');
    await runPipeline('job-1');
    const row = m.insertedArticles[0] as Record<string, unknown>;
    expect(row.title).toBe('Aplicação prática da matriz de Kraljic');
    expect(row.theme).toBe('Kraljic');
    expect(row.summary).toBe('Caso aplicado a varejo de alimentos');
  });

  it('does NOT call classifyContent on dedup hit', async () => {
    const m = await setupMocks({ job: baseJob, existingArticleId: 'existing-art-9' });
    const { runPipeline } = await import('@/lib/ingest/pipeline');
    await runPipeline('job-1');
    expect(m.classifyContent).not.toHaveBeenCalled();
  });
});
