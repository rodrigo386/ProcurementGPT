// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fixtureChunks = [
  { id: 'c0', ord: 0, content: 'A'.repeat(3000) },
  { id: 'c1', ord: 1, content: 'B'.repeat(3000) },
  { id: 'c2', ord: 2, content: 'C'.repeat(2000) },
];

function mockSupabase(opts: { chunks?: typeof fixtureChunks } = {}) {
  vi.doMock('@/lib/db/supabase-browser', () => ({
    supabaseBrowser: () => ({
      from: (table: string) => {
        if (table === 'chunks') {
          return {
            select: () => ({
              eq: () => ({
                order: async () => ({ data: opts.chunks ?? fixtureChunks, error: null }),
              }),
            }),
          };
        }
        return { select: () => ({}) };
      },
    }),
  }));
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  cleanup();
});

const article = {
  id: 'a1',
  title: 'Matriz de Kraljic',
  author: 'Silva, J.',
  language: 'pt',
  published_at: '2024-01-01',
  metadata: { content_hash: '3a7fb29c1234' },
  ingested_at: '2026-05-01T10:00:00Z',
  source_chars: 7600,
};

describe('<ArticleDetail/>', () => {
  it('renders "N chunks · ≈X% absorvido" once chunks load', async () => {
    mockSupabase();
    const { ArticleDetail } = await import('@/components/admin/ArticleDetail');
    render(<ArticleDetail article={article} onDeleted={() => {}} />);

    // 3 chunks of 3000+3000+2000 = 8000 chars; source_chars 7600 => 105%.
    await waitFor(() =>
      expect(screen.getByText(/3 chunks · ≈105% absorvido/i)).toBeDefined(),
    );
  });

  it('renders one <details> per chunk, all collapsed by default', async () => {
    mockSupabase();
    const { ArticleDetail } = await import('@/components/admin/ArticleDetail');
    const { container } = render(<ArticleDetail article={article} onDeleted={() => {}} />);

    await waitFor(() => expect(container.querySelectorAll('details').length).toBe(3));
    container.querySelectorAll('details').forEach((d) => {
      expect((d as HTMLDetailsElement).open).toBe(false);
    });
  });

  it('expands the chunk content when the user clicks the summary', async () => {
    mockSupabase({
      chunks: [{ id: 'c0', ord: 0, content: 'CONTEÚDO_LONGO_DO_CHUNK'.repeat(50) }],
    });
    const { ArticleDetail } = await import('@/components/admin/ArticleDetail');
    const { container } = render(<ArticleDetail article={article} onDeleted={() => {}} />);

    const details = await waitFor(() => {
      const el = container.querySelector('details');
      expect(el).toBeTruthy();
      return el as HTMLDetailsElement;
    });
    expect(details.open).toBe(false);
    const summary = details.querySelector('summary')!;
    await userEvent.click(summary);
    expect(details.open).toBe(true);
  });

  it('shows "0%" instead of NaN when source_chars is 0', async () => {
    mockSupabase();
    const { ArticleDetail } = await import('@/components/admin/ArticleDetail');
    render(
      <ArticleDetail
        article={{ ...article, source_chars: 0 }}
        onDeleted={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/3 chunks · ≈0% absorvido/i)).toBeDefined(),
    );
  });

  it('renders all returned chunks (no client-side limit)', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `c${i}`,
      ord: i,
      content: `chunk ${i}`,
    }));
    mockSupabase({ chunks: many });
    const { ArticleDetail } = await import('@/components/admin/ArticleDetail');
    const { container } = render(<ArticleDetail article={article} onDeleted={() => {}} />);

    await waitFor(() => expect(container.querySelectorAll('details').length).toBe(50));
  });
});
