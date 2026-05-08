'use client';

import { useMemo } from 'react';
import { TAXONOMY, type Theme } from '@/lib/ingest/taxonomy';

export type ThemeFilter = Theme | 'all';

type Props = {
  articles: Array<{ theme: string }>;
  selected: ThemeFilter;
  onSelect: (t: ThemeFilter) => void;
};

export function ThemeSidebar({ articles, selected, onSelect }: Props) {
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    map.set('all', articles.length);
    for (const t of TAXONOMY) map.set(t, 0);
    for (const a of articles) {
      if (TAXONOMY.includes(a.theme as Theme)) {
        map.set(a.theme, (map.get(a.theme) ?? 0) + 1);
      }
    }
    return map;
  }, [articles]);

  return (
    <nav className="border-r border-border p-2 space-y-0.5 text-sm bg-muted/30">
      <ThemeButton
        label="Todos"
        count={counts.get('all') ?? 0}
        active={selected === 'all'}
        onClick={() => onSelect('all')}
      />
      <div className="h-px bg-border my-1" />
      {TAXONOMY.map((t) => (
        <ThemeButton
          key={t}
          label={t}
          count={counts.get(t) ?? 0}
          active={selected === t}
          onClick={() => onSelect(t)}
        />
      ))}
    </nav>
  );
}

function ThemeButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const base = 'flex items-center justify-between w-full px-2 py-1.5 rounded text-left transition-colors';
  const colors = active ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-accent';
  const dim = count === 0 && !active ? 'text-muted-foreground' : '';
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
      className={`${base} ${colors} ${dim}`}
    >
      <span className="truncate">{label}</span>
      <span className="text-xs text-muted-foreground tabular-nums ml-2">{count}</span>
    </button>
  );
}
