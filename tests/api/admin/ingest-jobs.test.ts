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

describe('DELETE /api/admin/ingest/jobs', () => {
  it('non-admin → 404', async () => {
    mockAuth('user');
    const { DELETE } = await import('@/app/api/admin/ingest/jobs/route');
    const res = await DELETE();
    expect(res.status).toBe(404);
  });

  it('admin → deletes done+error jobs scoped to user, returns count', async () => {
    mockAuth('admin');
    const calls: Array<{ kind: string; payload?: unknown }> = [];

    vi.doMock('@/lib/db/supabase', () => ({
      getServerSupabase: () => ({
        from: () => {
          const builder: Record<string, unknown> = {};
          builder.delete = vi.fn().mockImplementation(() => {
            calls.push({ kind: 'delete' });
            return builder;
          });
          builder.in = vi.fn().mockImplementation((col: string, vals: unknown[]) => {
            calls.push({ kind: 'in', payload: { col, vals } });
            return builder;
          });
          builder.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
            calls.push({ kind: 'eq', payload: { col, val } });
            return builder;
          });
          builder.select = vi.fn().mockResolvedValue({
            data: [{ id: 'j1' }, { id: 'j2' }],
            error: null,
          });
          return builder;
        },
      }),
    }));

    const { DELETE } = await import('@/app/api/admin/ingest/jobs/route');
    const res = await DELETE();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; deleted: number };
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(2);

    // Verify the delete was scoped to done+error statuses
    expect(calls.some((c) => c.kind === 'in' && JSON.stringify((c.payload as { vals: unknown[] }).vals) === JSON.stringify(['done', 'error']))).toBe(true);
    // Verify scoped to user_id
    expect(calls.some((c) => c.kind === 'eq' && (c.payload as { col: string }).col === 'user_id')).toBe(true);
  });

  it('admin → does not delete queued/running jobs', async () => {
    mockAuth('admin');
    const inCalls: Array<string[]> = [];

    vi.doMock('@/lib/db/supabase', () => ({
      getServerSupabase: () => ({
        from: () => {
          const builder: Record<string, unknown> = {};
          builder.delete = vi.fn().mockReturnValue(builder);
          builder.in = vi.fn().mockImplementation((_col: string, vals: string[]) => {
            inCalls.push(vals);
            return builder;
          });
          builder.eq = vi.fn().mockReturnValue(builder);
          builder.select = vi.fn().mockResolvedValue({ data: [], error: null });
          return builder;
        },
      }),
    }));

    const { DELETE } = await import('@/app/api/admin/ingest/jobs/route');
    await DELETE();

    // The statuses passed to .in() must NOT include 'queued' or 'running'
    for (const vals of inCalls) {
      expect(vals).not.toContain('queued');
      expect(vals).not.toContain('running');
    }
  });
});

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
