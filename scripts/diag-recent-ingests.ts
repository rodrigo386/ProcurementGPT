#!/usr/bin/env tsx
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '@/lib/db/supabase';

async function main(): Promise<void> {
  const sb = getServerSupabase();

  // 10 most recent jobs
  const { data: jobs, error: jErr } = await sb
    .from('ingestion_jobs')
    .select(
      'id, filename, mime_type, size_bytes, status, stage, chunks_count, error_message, article_id, created_at, finished_at',
    )
    .order('created_at', { ascending: false })
    .limit(10);
  if (jErr) {
    console.error(`[diag] jobs select failed: ${jErr.message}`);
    process.exit(1);
  }

  console.log('=== 10 jobs mais recentes ===');
  for (const j of jobs ?? []) {
    const sizeMb = (j.size_bytes / 1024 / 1024).toFixed(2);
    console.log(
      `${j.created_at} | ${j.filename} | ${sizeMb}MB | status=${j.status} stage=${j.stage} chunks=${j.chunks_count} article=${j.article_id?.slice(0, 8) ?? 'none'} ${j.error_message ? '| err=' + j.error_message : ''}`,
    );
  }

  // For each completed job with an article, look up parser + source_chars + actual chunk count
  console.log('\n=== detalhes dos artigos recentes ===');
  const articleIds = (jobs ?? []).map((j) => j.article_id).filter(Boolean) as string[];
  if (articleIds.length === 0) {
    console.log('nenhum artigo nos jobs recentes');
    return;
  }
  const { data: arts, error: aErr } = await sb
    .from('articles')
    .select('id, title, theme, source_chars, metadata, ingested_at')
    .in('id', articleIds);
  if (aErr) {
    console.error(`[diag] articles select failed: ${aErr.message}`);
    process.exit(1);
  }
  for (const a of arts ?? []) {
    const parser = (a.metadata as Record<string, unknown> | null)?.['parser'] ?? 'unknown';
    const filename = (a.metadata as Record<string, unknown> | null)?.['source_filename'] ?? '?';
    const { count } = await sb
      .from('chunks')
      .select('id', { count: 'exact', head: true })
      .eq('article_id', a.id);
    const { data: kindData } = await sb
      .from('chunks')
      .select('metadata')
      .eq('article_id', a.id);
    const kindCounts = { text: 0, table: 0, figure: 0, other: 0 } as Record<string, number>;
    for (const c of kindData ?? []) {
      const k = ((c.metadata as Record<string, unknown> | null)?.['kind'] as string) ?? 'other';
      kindCounts[k] = (kindCounts[k] ?? 0) + 1;
    }
    console.log(
      `${a.id.slice(0, 8)} | parser=${parser} | source_chars=${a.source_chars} | total_chunks=${count} | kinds=${JSON.stringify(kindCounts)} | file=${filename} | title="${a.title}"`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
