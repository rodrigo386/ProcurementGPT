'use client';

import { useCallback, useEffect, useState } from 'react';
import { Dropzone } from '@/components/admin/Dropzone';
import { JobsLive } from '@/components/admin/JobsLive';
import { JobsRecent } from '@/components/admin/JobsRecent';

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

const POLL_MS = 2000;
const SETTLE_DELAY_MS = 5000;

export function IngestRoot() {
  const [jobs, setJobs] = useState<Job[]>([]);

  const fetchJobs = useCallback(async () => {
    const res = await fetch('/api/admin/ingest/jobs', { cache: 'no-store' });
    if (!res.ok) return;
    const body = (await res.json()) as { jobs: Job[] };
    setJobs(body.jobs);
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  useEffect(() => {
    const hasActive = jobs.some((j) => j.status === 'running' || j.status === 'queued');
    if (!hasActive) return;
    const id = setInterval(fetchJobs, POLL_MS);
    return () => clearInterval(id);
  }, [jobs, fetchJobs]);

  // Settle: poll once more 5s after the last active job clears, to capture final state.
  useEffect(() => {
    const hasActive = jobs.some((j) => j.status === 'running' || j.status === 'queued');
    if (hasActive) return;
    const t = setTimeout(fetchJobs, SETTLE_DELAY_MS);
    return () => clearTimeout(t);
  }, [jobs, fetchJobs]);

  const onRetry = useCallback(
    async (id: string) => {
      await fetch(`/api/admin/ingest/retry/${id}`, { method: 'POST' });
      await fetchJobs();
    },
    [fetchJobs],
  );

  const onClearRecents = useCallback(async () => {
    await fetch('/api/admin/ingest/jobs', { method: 'DELETE' });
    await fetchJobs();
  }, [fetchJobs]);

  const liveJobs = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const recentJobs = jobs.filter((j) => j.status === 'done' || j.status === 'error').slice(0, 10);

  const counts = {
    queued: jobs.filter((j) => j.status === 'queued').length,
    running: jobs.filter((j) => j.status === 'running').length,
    doneToday: jobs.filter(
      (j) =>
        j.status === 'done' &&
        j.finished_at &&
        new Date(j.finished_at).toDateString() === new Date().toDateString(),
    ).length,
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold">Ingestão</h2>
        <p className="text-xs text-muted-foreground">
          {counts.queued} em fila · {counts.running} rodando · {counts.doneToday} concluídos hoje
        </p>
      </div>
      <Dropzone onJobsCreated={() => fetchJobs()} />
      <JobsLive jobs={liveJobs} onRetry={onRetry} />
      <JobsRecent jobs={recentJobs} onRetry={onRetry} onClearRecents={onClearRecents} />
    </div>
  );
}
