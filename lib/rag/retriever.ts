import { getServerSupabase } from '@/lib/db/supabase';
import { embed } from '@/lib/llm/voyage';
import type { RetrievedChunk } from './types';

export type RetrieveOptions = {
  vectorK?: number;
  ftsK?: number;
  rrfK?: number;
  outK?: number;
  /** Internal hook for eval batching: skip embed call if vector already known. */
  preEmbedded?: number[];
};

const DEFAULTS = { vectorK: 20, ftsK: 20, rrfK: 60, outK: 30 } as const;

type VectorRow = {
  chunk_id: string;
  article_id: string;
  content: string;
  ord: number;
  similarity: number;
};
type FtsRow = {
  chunk_id: string;
  article_id: string;
  content: string;
  ord: number;
  rank: number;
};

export async function retrieve(
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  const { vectorK, ftsK, rrfK, outK } = { ...DEFAULTS, ...opts };
  const supabase = getServerSupabase();

  const embedding = opts.preEmbedded ?? (await embed([query], 'query'))[0];
  if (!embedding) return [];

  const [vecRes, ftsRes] = await Promise.all([
    supabase.rpc('match_chunks', {
      query_embedding: embedding,
      match_count: vectorK,
    }),
    supabase.rpc('search_chunks_fts', {
      query_text: query,
      match_count: ftsK,
    }),
  ]);

  const vecRows = (vecRes.error ? [] : (vecRes.data as VectorRow[])) ?? [];
  const ftsRows = (ftsRes.error ? [] : (ftsRes.data as FtsRow[])) ?? [];

  if (vecRes.error) console.warn('[rag/retriever] match_chunks error:', vecRes.error);
  if (ftsRes.error) console.warn('[rag/retriever] search_chunks_fts error:', ftsRes.error);

  if (vecRows.length === 0 && ftsRows.length === 0) return [];

  const fused = new Map<
    string,
    {
      chunkId: string;
      articleId: string;
      content: string;
      ord: number;
      vectorRank: number | null;
      ftsRank: number | null;
      rrfScore: number;
    }
  >();

  vecRows.forEach((row, i) => {
    const rank = i + 1;
    const score = 1 / (rrfK + rank);
    fused.set(row.chunk_id, {
      chunkId: row.chunk_id,
      articleId: row.article_id,
      content: row.content,
      ord: row.ord,
      vectorRank: rank,
      ftsRank: null,
      rrfScore: score,
    });
  });

  ftsRows.forEach((row, i) => {
    const rank = i + 1;
    const score = 1 / (rrfK + rank);
    const existing = fused.get(row.chunk_id);
    if (existing) {
      existing.ftsRank = rank;
      existing.rrfScore += score;
    } else {
      fused.set(row.chunk_id, {
        chunkId: row.chunk_id,
        articleId: row.article_id,
        content: row.content,
        ord: row.ord,
        vectorRank: null,
        ftsRank: rank,
        rrfScore: score,
      });
    }
  });

  const ranked = [...fused.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, outK);

  if (ranked.length === 0) return [];

  const articleIds = [...new Set(ranked.map((r) => r.articleId))];
  const { data: articles, error: articlesErr } = await supabase
    .from('articles')
    .select('id,title')
    .in('id', articleIds);

  if (articlesErr) console.warn('[rag/retriever] articles join error:', articlesErr);

  const titleById = new Map<string, string>();
  for (const a of (articles as { id: string; title: string }[] | null) ?? []) {
    titleById.set(a.id, a.title);
  }

  return ranked.map((r) => ({
    chunkId: r.chunkId,
    articleId: r.articleId,
    content: r.content,
    ord: r.ord,
    articleTitle: titleById.get(r.articleId) ?? '(unknown)',
    vectorRank: r.vectorRank,
    ftsRank: r.ftsRank,
    rrfScore: r.rrfScore,
    rerankScore: null,
  }));
}
