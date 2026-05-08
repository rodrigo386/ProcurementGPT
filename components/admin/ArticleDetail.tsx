'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { supabaseBrowser } from '@/lib/db/supabase-browser';
import { ConfirmDelete } from '@/components/admin/ConfirmDelete';

export type AdminArticle = {
  id: string;
  title: string;
  author: string | null;
  language: string;
  published_at: string | null;
  metadata: Record<string, unknown>;
  ingested_at: string;
  source_chars: number;
  theme: string;
  summary: string | null;
};

type ChunkKind = 'text' | 'table' | 'figure';

type ChunkMetadata = {
  kind?: ChunkKind;
  page?: number;
  caption?: string;
  figureKind?: 'flow' | 'chart' | 'diagram';
};

type Chunk = {
  id: string;
  ord: number;
  content: string;
  metadata: ChunkMetadata | null;
};

type Props = {
  article: AdminArticle | null;
  onDeleted: (id: string) => void;
  onUpdated?: (id: string, patch: { title?: string; theme?: string }) => void;
};

export function ArticleDetail({ article, onDeleted, onUpdated }: Props) {
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!article) {
      setChunks([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data } = await supabaseBrowser()
        .from('chunks')
        .select('id, ord, content, metadata')
        .eq('article_id', article.id)
        .order('ord', { ascending: true });
      if (cancelled) return;
      setChunks((data ?? []) as Chunk[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [article?.id]);

  if (!article) {
    return (
      <div className="text-sm text-muted-foreground p-4">
        Selecione um artigo na lista para inspecionar.
      </div>
    );
  }

  const hash = (article.metadata?.['content_hash'] as string | undefined) ?? '';
  const totalChunkChars = chunks.reduce((sum, c) => sum + c.content.length, 0);
  const absorvedPct =
    article.source_chars > 0
      ? Math.round((totalChunkChars / article.source_chars) * 100)
      : 0;

  async function handleDelete() {
    if (!article) return;
    const res = await fetch(`/api/admin/articles/${article.id}`, { method: 'DELETE' });
    if (res.ok) onDeleted(article.id);
  }

  return (
    <div className="p-4 space-y-3 overflow-y-auto h-full">
      <div>
        <h3 className="text-sm font-semibold">{article.title}</h3>
        <p className="text-xs text-muted-foreground">
          {[article.author, article.language?.toUpperCase(), article.published_at, hash ? `SHA: ${hash.slice(0, 8)}…` : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {chunks.length} chunks · ≈{absorvedPct}% absorvido
        </p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" onClick={() => setConfirmOpen(true)}>
          Excluir
        </Button>
      </div>
      <div className="space-y-1">
        {loading && <p className="text-xs text-muted-foreground">Carregando chunks…</p>}
        {!loading && chunks.length === 0 && (
          <p className="text-xs text-muted-foreground">Nenhum chunk disponível.</p>
        )}
        {chunks.map((c) => {
          const kind: ChunkKind = c.metadata?.kind ?? 'text';
          const page = c.metadata?.page;
          const badgeClass =
            kind === 'table'
              ? 'bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100'
              : kind === 'figure'
                ? 'bg-purple-100 text-purple-900 dark:bg-purple-900/40 dark:text-purple-100'
                : 'bg-muted text-muted-foreground';
          return (
            <details
              key={c.id}
              className="bg-muted/40 rounded-md border-l-2 border-border text-xs leading-relaxed"
            >
              <summary className="cursor-pointer p-2 hover:bg-muted/60">
                <span className={`mr-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${badgeClass}`}>
                  {kind}
                </span>
                <span className="text-muted-foreground mr-2 tabular-nums">#{c.ord}</span>
                {page !== undefined && (
                  <span className="text-muted-foreground mr-2 tabular-nums">p.{page}</span>
                )}
                {c.content.slice(0, 200)}
                {c.content.length > 200 && '…'}
              </summary>
              <pre className="mt-2 px-3 pb-3 whitespace-pre-wrap font-mono text-[11px]">
                {c.content}
              </pre>
            </details>
          );
        })}
      </div>
      <ConfirmDelete
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Excluir artigo"
        description={`Esta ação remove "${article.title}" e todos os chunks associados. Não pode ser desfeita.`}
        onConfirm={handleDelete}
      />
    </div>
  );
}
