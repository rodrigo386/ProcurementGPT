'use client';

import { useState } from 'react';
import { JobCard } from '@/components/admin/JobCard';
import { ConfirmDelete } from '@/components/admin/ConfirmDelete';

type Job = Parameters<typeof JobCard>[0]['job'];

type Props = {
  jobs: Job[];
  onRetry: (id: string) => void;
  onClearRecents: () => void | Promise<void>;
};

export function JobsRecent({ jobs, onRetry, onClearRecents }: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (jobs.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recentes</h3>
        <button
          className="text-xs text-muted-foreground hover:text-destructive transition-colors"
          onClick={() => setConfirmOpen(true)}
        >
          Limpar
        </button>
      </div>
      {jobs.map((j) => (
        <JobCard key={j.id} job={j} onRetry={onRetry} />
      ))}
      <ConfirmDelete
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Limpar recentes"
        description={`Esta ação remove ${jobs.length} ${jobs.length === 1 ? 'entrada' : 'entradas'} do histórico. Os artigos ingeridos NÃO são afetados.`}
        confirmLabel="Limpar"
        onConfirm={onClearRecents}
      />
    </div>
  );
}
