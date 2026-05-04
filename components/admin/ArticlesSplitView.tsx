'use client';

import { useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabaseBrowser } from '@/lib/db/supabase-browser';
import { ArticleDetail, type AdminArticle } from '@/components/admin/ArticleDetail';

type ArticleRow = AdminArticle & { chunks_count?: number };

export function ArticlesSplitView() {
  const [rows, setRows] = useState<ArticleRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabaseBrowser()
        .from('articles')
        .select('id, title, author, language, published_at, ingested_at, metadata, source_chars')
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
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        (r.author ?? '').toLowerCase().includes(q),
    );
  }, [rows, search]);

  const selected = rows.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Artigos</h2>
          <p className="text-xs text-muted-foreground">{rows.length} artigos</p>
        </div>
        <Input
          placeholder="Buscar por título ou autor…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
      </div>

      <div className="grid grid-cols-[1.4fr_1fr] gap-0 rounded-md border border-border overflow-hidden bg-card min-h-[420px]">
        <div className="border-r border-border max-h-[600px] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
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
            article={selected}
            onDeleted={(id) => {
              setRows((prev) => prev.filter((r) => r.id !== id));
              setSelectedId(null);
            }}
          />
        </div>
      </div>
    </div>
  );
}
