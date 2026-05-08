'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { supabaseBrowser } from '@/lib/db/supabase-browser';
import { ConfirmDelete } from '@/components/admin/ConfirmDelete';
import { TAXONOMY, isValidTheme } from '@/lib/ingest/taxonomy';
import { toast } from 'sonner';

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

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(article?.title ?? '');
  const [savingPatch, setSavingPatch] = useState(false);

  useEffect(() => {
    setTitleDraft(article?.title ?? '');
    setEditingTitle(false);
  }, [article?.id]);

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

  async function patchArticle(patch: { title?: string; theme?: string }) {
    if (!article) return;
    setSavingPatch(true);
    try {
      const res = await fetch(`/api/admin/articles/${article.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      onUpdated?.(article.id, patch);
      toast.success('Atualizado');
    } catch (err) {
      toast.error('Falha ao salvar', { description: String(err) });
    } finally {
      setSavingPatch(false);
    }
  }

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
        {editingTitle ? (
          <div className="flex gap-1.5 items-start">
            <Input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              className="text-sm"
              autoFocus
            />
            <Button
              size="sm"
              onClick={async () => {
                const t = titleDraft.trim();
                if (t.length < 3) {
                  toast.error('Título precisa ter ao menos 3 caracteres');
                  return;
                }
                await patchArticle({ title: t });
                setEditingTitle(false);
              }}
              disabled={savingPatch}
            >
              Salvar
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setTitleDraft(article.title);
                setEditingTitle(false);
              }}
            >
              Cancelar
            </Button>
          </div>
        ) : (
          <div className="flex items-start gap-1.5">
            <h3 className="text-sm font-semibold flex-1">{article.title}</h3>
            <button
              type="button"
              aria-label="Editar título"
              title="Editar título"
              onClick={() => setEditingTitle(true)}
              className="text-muted-foreground hover:text-foreground p-0.5"
            >
              ✎
            </button>
          </div>
        )}
        {article.summary && (
          <p className="text-xs text-muted-foreground italic mt-1">{article.summary}</p>
        )}
        <p className="text-xs text-muted-foreground mt-1">
          {[article.author, article.language?.toUpperCase(), article.published_at, hash ? `SHA: ${hash.slice(0, 8)}…` : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {chunks.length} chunks · ≈{absorvedPct}% absorvido
        </p>
        <div className="mt-2 flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Tema:</label>
          <select
            value={isValidTheme(article.theme) ? article.theme : 'Outros'}
            onChange={(e) => patchArticle({ theme: e.target.value })}
            disabled={savingPatch}
            className="text-xs rounded border border-border bg-background px-2 py-1"
          >
            {TAXONOMY.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
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
