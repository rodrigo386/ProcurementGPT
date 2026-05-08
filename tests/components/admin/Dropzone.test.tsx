// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => cleanup());

function makeFile(name: string, type: string, size: number): File {
  const buf = new Uint8Array(new ArrayBuffer(size));
  return new File([buf], name, { type });
}

describe('Dropzone', () => {
  it('drop event fires upload POST per file', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ jobId: 'j1' }) });
    vi.stubGlobal('fetch', fetchSpy);
    const { Dropzone } = await import('@/components/admin/Dropzone');
    const onJobsCreated = vi.fn();
    render(<Dropzone onJobsCreated={onJobsCreated} />);
    const dropArea = screen.getByTestId('dropzone');
    const file = makeFile('a.pdf', 'application/pdf', 1024);
    fireEvent.drop(dropArea, { dataTransfer: { files: [file] } });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(fetchSpy).toHaveBeenCalledWith('/api/admin/ingest/upload', expect.objectContaining({ method: 'POST' }));
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(expect.stringMatching(/\/api\/admin\/ingest\/run\//), expect.anything()),
    );
    expect(onJobsCreated).toHaveBeenCalled();
  });

  it('rejects oversize files (>100 MB) with no upload', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { Dropzone } = await import('@/components/admin/Dropzone');
    render(<Dropzone onJobsCreated={() => {}} />);
    const big = makeFile('big.pdf', 'application/pdf', 101 * 1024 * 1024);
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [big] } });
    await waitFor(() => expect(screen.getByText(/maior que 100 MB|too large/i)).toBeTruthy());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects unsupported MIME types', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { Dropzone } = await import('@/components/admin/Dropzone');
    render(<Dropzone onJobsCreated={() => {}} />);
    const wrong = makeFile('a.zip', 'application/zip', 1024);
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [wrong] } });
    await waitFor(() => expect(screen.getByText(/não suportado|unsupported/i)).toBeTruthy());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
