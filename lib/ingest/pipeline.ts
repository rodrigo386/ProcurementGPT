import { getServerSupabase } from '@/lib/db/supabase';
import { downloadFromIngestBucket, deleteFromIngestBucket } from '@/lib/db/storage';
import { parseSource } from '@/lib/ingest/parse-source';
import { chunkText, chunkBlocks } from '@/lib/ingest/chunker';
import { extractMetadata } from '@/lib/ingest/metadata';
import { sha256 } from '@/lib/ingest/hash';
import { classifyContent } from '@/lib/ingest/classify-content';
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

    // Dedup-first: compute hash before any LLM work so duplicate uploads
    // never burn classify tokens.
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

    // Dedup miss — classify first, then extract heuristic metadata.
    await update({ stage: 'classifying', progress: 30 });
    const classified = await classifyContent(sourceText, job.filename);

    // extractMetadata still runs for author/language/date.
    // meta.title is intentionally ignored — classified.title takes precedence.
    const meta = extractMetadata(sourceText, job.filename);

    const { data: article, error: insArtErr } = await sb
      .from('articles')
      .insert({
        title: classified.title,
        theme: classified.theme,
        summary: classified.summary,
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
