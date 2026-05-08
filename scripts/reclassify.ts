#!/usr/bin/env tsx
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '@/lib/db/supabase';
import { classifyContent } from '@/lib/ingest/classify-content';
import { TAXONOMY } from '@/lib/ingest/taxonomy';

type ArticleRow = {
  id: string;
  title: string;
  raw_md: string | null;
  metadata: Record<string, unknown> | null;
};

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const sb = getServerSupabase();

  const { data, error } = await sb
    .from('articles')
    .select('id, title, raw_md, metadata')
    .order('ingested_at', { ascending: true });
  if (error) {
    console.error(`[reclassify] supabase select failed: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as ArticleRow[];
  console.log(`[reclassify] processing ${rows.length} articles${dryRun ? ' (dry-run)' : ''}`);

  const counts: Record<string, number> = {};
  for (const t of TAXONOMY) counts[t] = 0;
  let failed = 0;

  for (const row of rows) {
    const filename = (row.metadata?.['source_filename'] as string | undefined) ?? row.id;
    if (!row.raw_md || row.raw_md.trim().length < 100) {
      console.warn(`[reclassify] skip ${row.id.slice(0, 8)} — empty raw_md`);
      failed++;
      continue;
    }
    try {
      const c = await classifyContent(row.raw_md, filename);
      console.log(
        `[reclassify] ${row.id.slice(0, 8)} → "${c.title.slice(0, 60)}" / ${c.theme}`,
      );
      counts[c.theme] = (counts[c.theme] ?? 0) + 1;
      if (!dryRun) {
        const { error: upErr } = await sb
          .from('articles')
          .update({ title: c.title, theme: c.theme, summary: c.summary })
          .eq('id', row.id);
        if (upErr) {
          console.error(`[reclassify] update failed for ${row.id}: ${upErr.message}`);
          failed++;
        }
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[reclassify] classify failed for ${row.id}: ${m}`);
      failed++;
    }
  }

  console.log('\n[reclassify] summary by theme:');
  for (const t of TAXONOMY) {
    console.log(`  ${t.padEnd(28, ' ')} ${counts[t] ?? 0}`);
  }
  console.log(`  failed/skipped: ${failed}`);
}

main().catch((err) => {
  console.error('[reclassify] fatal:', err);
  process.exit(1);
});
