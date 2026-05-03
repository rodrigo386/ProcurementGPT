// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

afterEach(() => cleanup());

const baseJob = {
  id: 'j1',
  filename: 'kraljic.pdf',
  status: 'running' as const,
  stage: 'embedding' as const,
  progress: 62,
  chunks_count: null,
  error_message: null,
  created_at: new Date(Date.now() - 14_000).toISOString(),
  updated_at: new Date().toISOString(),
  finished_at: null,
};

describe('JobCard', () => {
  it('running job renders progress bar and stage text', async () => {
    const { JobCard } = await import('@/components/admin/JobCard');
    render(<JobCard job={baseJob} onRetry={() => {}} />);
    expect(screen.getByText('kraljic.pdf')).toBeTruthy();
    expect(screen.getByText(/embedding/i)).toBeTruthy();
    expect(screen.getByText(/62%/)).toBeTruthy();
  });

  it('error job renders error message and Retry button', async () => {
    const errorJob = { ...baseJob, status: 'error' as const, stage: null, progress: 0, error_message: 'Parser falhou' };
    const { JobCard } = await import('@/components/admin/JobCard');
    render(<JobCard job={errorJob} onRetry={() => {}} />);
    expect(screen.getByText(/parser falhou/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry|tentar novamente/i })).toBeTruthy();
  });
});
