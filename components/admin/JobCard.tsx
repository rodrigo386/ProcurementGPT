'use client';

import { Loader2, Check, AlertTriangle, Clock, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Job = {
  id: string;
  filename: string;
  status: 'queued' | 'running' | 'done' | 'error';
  stage: 'parsing' | 'chunking' | 'embedding' | 'inserting' | 'deduplicated' | null;
  progress: number;
  chunks_count: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

type Props = { job: Job; onRetry: (id: string) => void };

const STAGE_LABEL: Record<string, string> = {
  parsing: 'Parsing',
  chunking: 'Chunking',
  embedding: 'Embedding',
  inserting: 'Inserting',
  deduplicated: 'Deduplicated',
};

function relative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(1, Math.floor(ms / 1000));
  if (s < 60) return `${s}s atrás`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min atrás`;
  const h = Math.floor(m / 60);
  return `${h}h atrás`;
}

export function JobCard({ job, onRetry }: Props) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-card p-3">
      <div className="shrink-0">
        {job.status === 'running' && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
        {job.status === 'queued' && <Clock className="h-4 w-4 text-muted-foreground" />}
        {job.status === 'done' && <Check className="h-4 w-4 text-emerald-600" />}
        {job.status === 'error' && <AlertTriangle className="h-4 w-4 text-destructive" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{job.filename}</div>
        <div className="text-xs text-muted-foreground truncate">
          {job.status === 'running' && (
            <>
              {STAGE_LABEL[job.stage ?? ''] ?? 'Processando'} · {job.progress}%
            </>
          )}
          {job.status === 'queued' && 'Em fila'}
          {job.status === 'done' && (
            job.stage === 'deduplicated'
              ? `Já estava na base — não duplicado · ${relative(job.finished_at ?? job.updated_at)}`
              : `${job.chunks_count ?? '?'} chunks · ${relative(job.finished_at ?? job.updated_at)}`
          )}
          {job.status === 'error' && (
            <span className="text-destructive">{job.error_message ?? 'Erro'}</span>
          )}
        </div>
      </div>
      {job.status === 'running' && (
        <div className="w-24 h-1.5 bg-muted rounded overflow-hidden shrink-0">
          <div className="h-full bg-primary transition-all" style={{ width: `${job.progress}%` }} />
        </div>
      )}
      {job.status === 'error' && (
        <Button size="sm" variant="ghost" onClick={() => onRetry(job.id)} aria-label="Retry">
          <RotateCw className="h-4 w-4 mr-1" />
          Tentar novamente
        </Button>
      )}
    </div>
  );
}
