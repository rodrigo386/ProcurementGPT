'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabaseBrowser } from '@/lib/db/supabase-browser';
import { ArticleDetail, type AdminArticle } from '@/components/admin/ArticleDetail';
import { ConfirmDelete } from '@/components/admin/ConfirmDelete';
import { ThemeSidebar, type ThemeFilter } from '@/components/admin/ThemeSidebar';

type ArticleRow = AdminArticle & { chunks_count?: number };

export function ArticlesSplitView() {
  const [rows, setRows] = useState<ArticleRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [themeFilter, setThemeFilter] = useState<ThemeFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulkOpen, setConfirmBulkOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabaseBrowser()
        .from('articles')
        .select('id, title, author, language, published_at, ingested_at, metadata, source_chars, theme, summary')
        .order('ingested_at', { ascending: false })
        .limit(100);
      if (cancelled) return;
      setRows((data ?? []) as ArticleRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    let out = themeFilter === 'all' ? rows : rows.filter((r) => r.theme === themeFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter(
        (r) => r.title.toLowerCase().includes(q) || (r.author ?? '').toLowerCase().includes(q),
      );
    }
    return out;
  }, [rows, search, themeFilter]);

  const detailArticle = rows.find((r) => r.id === selectedId) ?? null;

  // Header checkbox state for filtered rows
  const filteredIds = filtered.map((r) => r.id);
  const selectedInFiltered = filteredIds.filter((id) => selected.has(id));
  const allFilteredSelected = filteredIds.length > 0 && selectedInFiltered.length === filteredIds.length;
  const someFilteredSelected = selectedInFiltered.length > 0 && !allFilteredSelected;

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allFilteredSelected) {
      // Deselect all filtered
      setSelected((prev) => {
        const next = new Set(prev);
        filteredIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      // Select all filtered
      setSelected((prev) => {
        const next = new Set(prev);
        filteredIds.forEach((id) => next.add(id));
        return next;
      });
    }
  }

  async function handleBulkDelete() {
    setBulkDeleting(true);
    const ids = [...selected];
    try {
      const res = await fetch('/api/admin/articles/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(`Erro ao excluir artigos: ${data.error ?? res.status}`);
        return;
      }
      // Success: remove deleted rows from state
      setRows((prev) => prev.filter((r) => !ids.includes(r.id)));
      setSelected(new Set());
      if (selectedId && ids.includes(selectedId)) {
        setSelectedId(null);
      }
    } catch {
      toast.error('Erro de rede ao excluir artigos.');
    } finally {
      setBulkDeleting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Artigos</h2>
          <p className="text-xs text-muted-foreground">{rows.length} artigos</p>
        </div>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmBulkOpen(true)}
              disabled={bulkDeleting}
            >
              Excluir {selected.size} selecionados
            </Button>
          )}
          <Input
            placeholder="Buscar por título ou autor…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
          />
        </div>
      </div>

      <ConfirmDelete
        open={confirmBulkOpen}
        onOpenChange={setConfirmBulkOpen}
        title={`Excluir ${selected.size} artigos`}
        description={`Esta ação remove os ${selected.size} artigos selecionados e todos os chunks associados. Não pode ser desfeita.`}
        onConfirm={handleBulkDelete}
      />

      <div className="grid grid-cols-[180px_1.4fr_1fr] gap-0 rounded-md border border-border overflow-hidden bg-card min-h-[420px]">
        <div className="max-h-[600px] overflow-y-auto">
          <ThemeSidebar articles={rows} selected={themeFilter} onSelect={setThemeFilter} />
        </div>
        <div className="border-r border-l border-border max-h-[600px] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8 px-3">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded"
                    checked={allFilteredSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someFilteredSelected;
                    }}
                    onChange={toggleAll}
                    aria-label="Selecionar todos"
                  />
                </TableHead>
                <TableHead>Título</TableHead>
                <TableHead className="text-right w-20">Chunks</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow
                  key={r.id}
                  data-selected={selectedId === r.id ? 'true' : undefined}
                  className={`cursor-pointer ${selectedId === r.id ? 'bg-primary/10' : 'hover:bg-accent'}`}
                  onClick={() => setSelectedId(r.id)}
                >
                  <TableCell
                    className="w-8 px-3"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded"
                      checked={selected.has(r.id)}
                      onChange={() => toggleRow(r.id)}
                      aria-label={`Selecionar ${r.title}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium text-sm">{r.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {[r.author, (r.language ?? '').toUpperCase(), r.published_at]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                    {r.chunks_count ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="bg-background">
          <ArticleDetail
            article={detailArticle}
            onDeleted={(id) => {
              setRows((prev) => prev.filter((r) => r.id !== id));
              setSelectedId(null);
              setSelected((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
              });
            }}
            onUpdated={(id, patch) => {
              setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
            }}
          />
        </div>
      </div>
    </div>
  );
}
