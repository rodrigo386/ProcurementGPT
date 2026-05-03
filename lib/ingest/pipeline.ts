import { getServerSupabase } from '@/lib/db/supabase';
import { downloadFromIngestBucket, deleteFromIngestBucket } from '@/lib/db/storage';
import { parseFile } from '@/lib/ingest/parser';
import { chunkText } from '@/lib/ingest/chunker';
import { extractMetadata } from '@/lib/ingest/metadata';
import { sha256 } from '@/lib/ingest/hash';
import { embed } from '@/lib/llm/voyage';

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
    const parsed = await parseFile(blob, job.mime_type, job.filename);

    await update({ stage: 'chunking', progress: 20 });
    const chunks = chunkText(parsed.text);
    if (chunks.length === 0) throw new Error('Nenhum chunk gerado a partir do texto');

    const meta = extractMetadata(parsed.text, job.filename);
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
        raw_md: parsed.text,
        metadata: { content_hash: hash, source_filename: job.filename },
      })
      .select('id')
      .single();
    if (insArtErr || !article) {
      throw new Error(`article insert failed: ${insArtErr?.message ?? 'no row'}`);
    }

    await update({ stage: 'embedding', progress: 40 });
    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const slice = chunks.slice(i, i + EMBED_BATCH);
      const out = await embed(slice, 'document');
      embeddings.push(...out);
      const pct = 40 + Math.floor(((i + slice.length) / chunks.length) * 50);
      await update({ progress: Math.min(pct, 90) });
    }

    await update({ stage: 'inserting', progress: 92 });
    const rows = chunks.map((text, idx) => ({
      article_id: article.id,
      ord: idx,
      content: text,
      embedding: embeddings[idx],
      metadata: { source_filename: job.filename },
    }));
    for (let i = 0; i < rows.length; i += 50) {
      await sb.from('chunks').insert(rows.slice(i, i + 50));
    }

    await deleteFromIngestBucket(job.storage_path);
    await update({
      status: 'done',
      stage: null,
      progress: 100,
      chunks_count: chunks.length,
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
    // Storage file kept on failure (B2 retention policy) so admin can retry.
  }
}
