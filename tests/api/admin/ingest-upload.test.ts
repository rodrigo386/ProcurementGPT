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

function makeFormDataRequest(file: { name: string; type: string; buf: Uint8Array<ArrayBuffer> }): Request {
  const fd = new FormData();
  fd.append('file', new File([file.buf], file.name, { type: file.type }));
  return new Request('http://localhost/api/admin/ingest/upload', { method: 'POST', body: fd });
}

describe('POST /api/admin/ingest/upload', () => {
  it('non-admin → 404', async () => {
    mockAuth('user');
    const { POST } = await import('@/app/api/admin/ingest/upload/route');
    const res = await POST(makeFormDataRequest({ name: 'a.pdf', type: 'application/pdf', buf: new Uint8Array(new ArrayBuffer(10)) }));
    expect(res.status).toBe(404);
  });

  it('admin upload persists to storage and creates ingestion_jobs row, returns jobId', async () => {
    mockAuth('admin');
    const inserted: Record<string, unknown>[] = [];
    const uploaded: Array<{ path: string; size: number }> = [];

    vi.doMock('@/lib/db/storage', () => ({
      INGEST_BUCKET: 'ingest-uploads',
      uploadToIngestBucket: vi.fn().mockImplementation(async (path: string, buf: Buffer) => {
        uploaded.push({ path, size: buf.length });
      }),
    }));

    vi.doMock('@/lib/db/supabase', () => ({
      getServerSupabase: () => ({
        from: () => ({
          insert: (payload: Record<string, unknown>) => {
            inserted.push(payload);
            return {
              select: () => ({
                single: async () => ({ data: { id: 'job-1' }, error: null }),
              }),
            };
          },
        }),
      }),
    }));

    const { POST } = await import('@/app/api/admin/ingest/upload/route');
    const res = await POST(
      makeFormDataRequest({
        name: 'kraljic.pdf',
        type: 'application/pdf',
        buf: new Uint8Array(new ArrayBuffer(2048)),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBe('job-1');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.filename).toBe('kraljic.pdf');
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]!.path).toMatch(/admin-1\/.+\/kraljic\.pdf$/);
  });
});
