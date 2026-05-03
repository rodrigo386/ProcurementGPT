'use client';

import { JobCard } from '@/components/admin/JobCard';

type Job = Parameters<typeof JobCard>[0]['job'];

export function JobsLive({ jobs, onRetry }: { jobs: Job[]; onRetry: (id: string) => void }) {
  if (jobs.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Em andamento</h3>
      {jobs.map((j) => (
        <JobCard key={j.id} job={j} onRetry={onRetry} />
      ))}
    </div>
  );
}
