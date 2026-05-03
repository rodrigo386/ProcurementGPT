// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const articles = [
  {
    id: 'a1',
    title: 'Matriz de Kraljic na Prática Industrial',
    author: 'Silva, J.',
    language: 'pt',
    published_at: '2024-01-01',
    ingested_at: '2026-05-01T10:00:00Z',
    metadata: { content_hash: '3a7fb29c1234' },
    chunks_count: 28,
  },
  {
    id: 'a2',
    title: 'The Strategic Sourcing Process Model',
    author: 'Monczka, R.',
    language: 'en',
    published_at: '2023-08-01',
    ingested_at: '2026-05-02T10:00:00Z',
    metadata: { content_hash: 'deadbeef' },
    chunks_count: 42,
  },
];

beforeEach(() => {
  vi.resetModules();
  vi.doMock('@/lib/db/supabase-browser', () => ({
    supabaseBrowser: () => ({
      from: (table: string) => {
        if (table === 'articles') {
          return {
            select: () => ({
              order: () => ({
                limit: async () => ({ data: articles, error: null }),
              }),
            }),
          };
        }
        if (table === 'chunks') {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({
                    data: [{ id: 'c1', ord: 0, content: 'A matriz de Kraljic propõe…' }],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return { select: () => ({}) };
      },
    }),
  }));
});
afterEach(() => cleanup());

describe('ArticlesSplitView', () => {
  it('renders the article list on mount', async () => {
    const { ArticlesSplitView } = await import('@/components/admin/ArticlesSplitView');
    render(<ArticlesSplitView />);
    expect(await screen.findByText('Matriz de Kraljic na Prática Industrial')).toBeTruthy();
    expect(screen.getByText('The Strategic Sourcing Process Model')).toBeTruthy();
  });

  it('clicking a row shows its title in the detail panel', async () => {
    const { ArticlesSplitView } = await import('@/components/admin/ArticlesSplitView');
    render(<ArticlesSplitView />);
    const row = await screen.findByText('Matriz de Kraljic na Prática Industrial');
    await userEvent.click(row);
    await waitFor(() =>
      expect(screen.getAllByText('Matriz de Kraljic na Prática Industrial').length).toBeGreaterThanOrEqual(2),
    );
  });

  it('clicking Excluir + Confirm fires DELETE on the article and removes it from the list', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchSpy);
    const { ArticlesSplitView } = await import('@/components/admin/ArticlesSplitView');
    render(<ArticlesSplitView />);
    const row = await screen.findByText('Matriz de Kraljic na Prática Industrial');
    await userEvent.click(row);
    // Click the Excluir button in the detail panel (opens confirm dialog)
    await userEvent.click(await screen.findByRole('button', { name: /excluir/i }));
    // Click the destructive Excluir button in the dialog (there are now 2 buttons matching /excluir/i)
    const allExcluir = await screen.findAllByRole('button', { name: /excluir/i });
    // Last one is the dialog's confirm button
    await userEvent.click(allExcluir[allExcluir.length - 1]!);
    expect(fetchSpy).toHaveBeenCalledWith('/api/admin/articles/a1', { method: 'DELETE' });
    await waitFor(() =>
      expect(screen.queryByText('Matriz de Kraljic na Prática Industrial')).toBeNull(),
    );
  });
});
