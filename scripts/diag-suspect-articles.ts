#!/usr/bin/env tsx
/**
 * Lists articles whose extraction looks suspiciously thin given the source PDF size.
 *
 * Heuristic: source_chars-to-filesize ratio. Healthy academic PDF averages
 * ~10-20 chars/KB for raw_md; under-extracted ones come in at <2 chars/KB.
 *
 * Use this after the 2026-05-08 multimodal prompt fix to identify which past
 * uploads should be re-ingested via /admin/ingest.
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '@/lib/db/supabase';

async function main(): Promise<void> {
  const sb = getServerSupabase();
  const { data: arts, error: aErr } = await sb
    .from('articles')
    .select('id, title, source_chars, metadata, ingested_at')
    .order('ingested_at', { ascending: false });
  if (aErr) {
    console.error(`articles select failed: ${aErr.message}`);
    process.exit(1);
  }

  // Pull most recent jobs to recover filesize per article
  const articleIds = (arts ?? []).map((a) => a.id);
  const { data: jobs } = await sb
    .from('ingestion_jobs')
    .select('article_id, size_bytes, filename, status')
    .in('article_id', articleIds);
  const sizeByArticle = new Map<string, number>();
  const filenameByArticle = new Map<string, string>();
  for (const j of jobs ?? []) {
    if (j.article_id) {
      sizeByArticle.set(j.article_id, j.size_bytes);
      filenameByArticle.set(j.article_id, j.filename);
    }
  }

  type Row = {
    id: string;
    title: string;
    parser: string;
    sourceChars: number;
    fileKb: number;
    charsPerKb: number;
    chunkCount: number;
    filename: string;
  };

  const rows: Row[] = [];
  for (const a of arts ?? []) {
    const size = sizeByArticle.get(a.id);
    if (!size) continue;
    const { count } = await sb
      .from('chunks')
      .select('id', { count: 'exact', head: true })
      .eq('article_id', a.id);
    const meta = a.metadata as Record<string, unknown> | null;
    rows.push({
      id: a.id,
      title: a.title,
      parser: (meta?.['parser'] as string) ?? 'unknown',
      sourceChars: a.source_chars,
      fileKb: Math.round(size / 1024),
      charsPerKb: a.source_chars / (size / 1024),
      chunkCount: count ?? 0,
      filename: filenameByArticle.get(a.id) ?? '?',
    });
  }

  rows.sort((a, b) => a.charsPerKb - b.charsPerKb);

  console.log('=== articles ranked by under-extraction risk (lowest chars/KB first) ===');
  console.log('id        | parser              | size  | chars  | c/KB  | chunks | file');
  for (const r of rows) {
    const flag = r.charsPerKb < 2 && r.fileKb > 200 ? ' ⚠️' : '';
    console.log(
      `${r.id.slice(0, 8)} | ${r.parser.padEnd(19)} | ${String(r.fileKb).padStart(4)}KB | ${String(r.sourceChars).padStart(6)} | ${r.charsPerKb.toFixed(2).padStart(5)} | ${String(r.chunkCount).padStart(6)} | ${r.filename}${flag}`,
    );
  }

  const suspect = rows.filter((r) => r.charsPerKb < 2 && r.fileKb > 200);
  console.log(`\n${suspect.length} suspect articles flagged. Re-upload these via /admin/ingest after deleting the existing row.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
