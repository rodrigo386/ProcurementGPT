import { describe, expect, it, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

function mockAuth(role: 'admin' | 'user') {
  vi.doMock('@/lib/auth', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/auth')>();
    return {
      ...actual,
      requireAdmin: vi.fn().mockImplementation(async () => {
        if (role !== 'admin') throw new (actual.NotAdmin)();
        return {
          user: { id: 'admin-1', email: 'a@b.com' } as unknown,
          profile: { id: 'admin-1', role: 'admin', display_name: null },
        };
      }),
    };
  });
}

describe('GET /api/admin/ingest/jobs', () => {
  it('admin → returns jobs array, runs cleanup pass (delete done > 7d, mark stale running as error)', async () => {
    mockAuth('admin');
    const calls: Array<{ kind: string; payload?: unknown }> = [];

    vi.doMock('@/lib/db/supabase', () => ({
      getServerSupabase: () => ({
        from: () => {
          const builder: Record<string, unknown> = {};
          builder.select = vi.fn().mockImplementation((cols: string) => {
            calls.push({ kind: 'select', payload: cols });
            return builder;
          });
          builder.update = vi.fn().mockImplementation((payload: unknown) => {
            calls.push({ kind: 'update', payload });
            return builder;
          });
          builder.delete = vi.fn().mockImplementation(() => {
            calls.push({ kind: 'delete' });
            return builder;
          });
          builder.eq = vi.fn().mockReturnValue(builder);
          builder.lt = vi.fn().mockReturnValue(builder);
          builder.order = vi.fn().mockResolvedValue({
            data: [{ id: 'j1', status: 'queued', created_at: '2026-05-03T10:00:00Z' }, { id: 'j2', status: 'done', created_at: '2026-05-03T09:00:00Z' }],
            error: null,
          });
          // Terminal for delete/update chains: simulate awaitable.
          builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
          return builder;
        },
      }),
    }));
    const { GET } = await import('@/app/api/admin/ingest/jobs/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: Array<{ id: string }> };
    expect(body.jobs).toHaveLength(2);
    expect(calls.some((c) => c.kind === 'delete')).toBe(true);
    expect(calls.some((c) => c.kind === 'update')).toBe(true);
  });

  it('non-admin → 404', async () => {
    mockAuth('user');
    const { GET } = await import('@/app/api/admin/ingest/jobs/route');
    const res = await GET();
    expect(res.status).toBe(404);
  });
});
