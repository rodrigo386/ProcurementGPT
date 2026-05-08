#!/usr/bin/env tsx
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '@/lib/db/supabase';

async function main(): Promise<void> {
  const articleId = process.argv[2];
  if (!articleId) {
    console.error('usage: diag-article-content.ts <article_id_prefix>');
    process.exit(1);
  }
  const sb = getServerSupabase();

  // pull recent and match prefix client-side (uuid can't be `like`'d directly)
  const { data: arts, error: aErr } = await sb
    .from('articles')
    .select('id, title, source_chars, raw_md, metadata, ingested_at')
    .order('ingested_at', { ascending: false })
    .limit(50);
  if (aErr || !arts) {
    console.error(`articles select failed: ${aErr?.message ?? 'no rows'}`);
    process.exit(1);
  }
  const article = arts.find((a) => a.id.startsWith(articleId));
  if (!article) {
    console.error(`no article id starts with ${articleId}`);
    process.exit(1);
  }
  console.log(`article: ${article.id}`);
  console.log(`title: ${article.title}`);
  console.log(`source_chars: ${article.source_chars}`);
  console.log(`parser: ${(article.metadata as Record<string, unknown> | null)?.['parser']}`);
  console.log(`\n--- raw_md (first 500 chars) ---`);
  console.log((article.raw_md ?? '').slice(0, 500));
  console.log(`...`);
  console.log(`--- raw_md (last 500 chars) ---`);
  console.log((article.raw_md ?? '').slice(-500));

  const { data: chunks } = await sb
    .from('chunks')
    .select('ord, content, metadata')
    .eq('article_id', article.id)
    .order('ord', { ascending: true });

  console.log(`\n--- ${chunks?.length ?? 0} chunks ---`);
  for (const c of chunks ?? []) {
    const meta = c.metadata as Record<string, unknown> | null;
    console.log(`\n[chunk ${c.ord}] kind=${meta?.['kind']} page=${meta?.['page']} caption=${meta?.['caption'] ?? ''} len=${c.content.length}`);
    console.log(c.content.slice(0, 400));
    if (c.content.length > 400) console.log(`... [+${c.content.length - 400} chars]`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
