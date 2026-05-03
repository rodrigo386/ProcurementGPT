import { describe, expect, it, vi, beforeEach } from 'vitest';

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
  parsedText?: string;
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

  vi.doMock('@/lib/ingest/parser', () => ({
    parseFile: vi.fn().mockImplementation(async () => {
      if (opts.parseShouldThrow) throw new Error('Conteúdo muito curto — OCR necessário');
      return { text: opts.parsedText ?? 'Texto longo. '.repeat(80), pageCount: 5 };
    }),
  }));

  vi.doMock('@/lib/llm/voyage', () => ({
    embed: vi.fn().mockImplementation(async (texts: string[]) =>
      texts.map(() => Array(1024).fill(0)),
    ),
  }));

  // Chainable Supabase mock
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
  it('happy path: writes article, embeds chunks, marks done with chunks_count', async () => {
    const m = setupMocks({ job: baseJob });
    const { runPipeline } = await import('@/lib/ingest/pipeline');
    await runPipeline('job-1');
    expect(m.insertedArticles).toHaveLength(1);
    expect(m.insertedChunkBatches.length).toBeGreaterThan(0);
    const finalUpdate = m.updateCalls[m.updateCalls.length - 1]!;
    expect(finalUpdate.status).toBe('done');
    expect(finalUpdate.chunks_count).toBeGreaterThan(0);
    expect(finalUpdate.article_id).toBe('new-art-1');
  });

  it('parser failure marks job status=error with the parser message; storage file is NOT deleted', async () => {
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

  it('dedup hit: existing article matched by content_hash → status=done, chunks_count=0, no inserts', async () => {
    const m = setupMocks({ job: baseJob, existingArticleId: 'existing-art-9' });
    const { runPipeline } = await import('@/lib/ingest/pipeline');
    await runPipeline('job-1');
    expect(m.insertedArticles).toHaveLength(0);
    expect(m.insertedChunkBatches).toHaveLength(0);
    const finalUpdate = m.updateCalls[m.updateCalls.length - 1]!;
    expect(finalUpdate.status).toBe('done');
    expect(finalUpdate.chunks_count).toBe(0);
    expect(finalUpdate.article_id).toBe('existing-art-9');
    expect(finalUpdate.stage).toBe('deduplicated');
  });
});
