// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import type { ChatMessage } from '@/lib/rag/types';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => cleanup());

type Row = { id: string; title: string; messages: ChatMessage[]; updated_at: string };

function mockBrowser(opts: {
  initialRows?: Row[];
  insertRow?: Row;
  insertError?: { message: string } | null;
  updateError?: { message: string } | null;
  deleteError?: { message: string } | null;
}) {
  const insertCalls: Array<Record<string, unknown>> = [];
  const updateCalls: Array<Record<string, unknown>> = [];
  const deleteCalls: string[] = [];

  function builder() {
    let action: 'select' | 'insert' | 'update' | 'delete' | null = null;
    let pendingPayload: Record<string, unknown> | null = null;
    return {
      select: vi.fn().mockImplementation(function (this: any) {
        action = action ?? 'select';
        return this;
      }),
      order: vi.fn().mockImplementation(async () => ({
        data: opts.initialRows ?? [],
        error: null,
      })),
      insert: vi.fn().mockImplementation(function (this: any, payload: Record<string, unknown>) {
        action = 'insert';
        pendingPayload = payload;
        insertCalls.push(payload);
        return this;
      }),
      single: vi.fn().mockImplementation(async () => ({
        data: opts.insertRow ?? null,
        error: opts.insertError ?? null,
      })),
      update: vi.fn().mockImplementation(function (this: any, payload: Record<string, unknown>) {
        action = 'update';
        pendingPayload = payload;
        return this;
      }),
      delete: vi.fn().mockImplementation(function (this: any) {
        action = 'delete';
        return this;
      }),
      eq: vi.fn().mockImplementation(async (_col: string, val: string) => {
        if (action === 'update') {
          updateCalls.push({ id: val, ...(pendingPayload ?? {}) });
          return { error: opts.updateError ?? null };
        }
        if (action === 'delete') {
          deleteCalls.push(val);
          return { error: opts.deleteError ?? null };
        }
        return { error: null };
      }),
    };
  }

  vi.doMock('@/lib/db/supabase-browser', () => ({
    supabaseBrowser: () => ({ from: () => builder() }),
  }));

  return { insertCalls, updateCalls, deleteCalls };
}

const isoNow = () => new Date().toISOString();

describe('useChatSessionsRemote', () => {
  it('auto-creates one session on mount when DB returns no rows', async () => {
    const fresh: Row = { id: 'new-1', title: 'Nova conversa', messages: [], updated_at: isoNow() };
    mockBrowser({ initialRows: [], insertRow: fresh });
    const { useChatSessionsRemote } = await import('@/hooks/useChatSessionsRemote');
    const { result } = renderHook(() => useChatSessionsRemote());
    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });
    expect(result.current.currentId).toBe('new-1');
    expect(result.current.current.id).toBe('new-1');
    expect(result.current.current.messages).toEqual([]);
  });

  it('loads existing rows on mount and selects the first (newest) as current', async () => {
    const rows: Row[] = [
      { id: 'a', title: 'recent', messages: [{ role: 'user', content: 'hi' }], updated_at: '2026-05-02T10:00:00Z' },
      { id: 'b', title: 'older', messages: [], updated_at: '2026-05-01T10:00:00Z' },
    ];
    mockBrowser({ initialRows: rows });
    const { useChatSessionsRemote } = await import('@/hooks/useChatSessionsRemote');
    const { result } = renderHook(() => useChatSessionsRemote());
    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });
    expect(result.current.currentId).toBe('a');
    expect(result.current.current.title).toBe('recent');
    expect(result.current.current.messages).toHaveLength(1);
  });

  it('createNew inserts a row, prepends to local state, switches currentId', async () => {
    const initial: Row = { id: 'a', title: 'first', messages: [], updated_at: '2026-05-02T10:00:00Z' };
    const fresh: Row = { id: 'b', title: 'Nova conversa', messages: [], updated_at: '2026-05-02T11:00:00Z' };
    const m = mockBrowser({ initialRows: [initial], insertRow: fresh });
    const { useChatSessionsRemote } = await import('@/hooks/useChatSessionsRemote');
    const { result } = renderHook(() => useChatSessionsRemote());
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    await act(async () => {
      await result.current.createNew();
    });
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));
    expect(result.current.currentId).toBe('b');
    expect(result.current.sessions[0]!.id).toBe('b');
    expect(result.current.sessions[1]!.id).toBe('a');
    expect(m.insertCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('updateMessages updates the current row with messages + derived title (optimistic local update)', async () => {
    const initial: Row = { id: 'a', title: 'Nova conversa', messages: [], updated_at: '2026-05-02T10:00:00Z' };
    const m = mockBrowser({ initialRows: [initial] });
    const { useChatSessionsRemote } = await import('@/hooks/useChatSessionsRemote');
    const { result } = renderHook(() => useChatSessionsRemote());
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'O que é Kraljic?' },
      { role: 'assistant', content: 'A matriz...' },
    ];
    await act(async () => {
      await result.current.updateMessages(msgs);
    });
    expect(result.current.current.messages).toEqual(msgs);
    expect(result.current.current.title).toBe('O que é Kraljic?');
    expect(m.updateCalls.length).toBe(1);
    expect(m.updateCalls[0]!.id).toBe('a');
    expect(m.updateCalls[0]!.title).toBe('O que é Kraljic?');
    expect(m.updateCalls[0]!.messages).toEqual(msgs);
  });

  it('deleteSession removes the row from DB and from local state; switches current if deleted was current', async () => {
    const rows: Row[] = [
      { id: 'a', title: 'one', messages: [], updated_at: '2026-05-02T10:00:00Z' },
      { id: 'b', title: 'two', messages: [], updated_at: '2026-05-02T09:00:00Z' },
    ];
    const m = mockBrowser({ initialRows: rows });
    const { useChatSessionsRemote } = await import('@/hooks/useChatSessionsRemote');
    const { result } = renderHook(() => useChatSessionsRemote());
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));
    expect(result.current.currentId).toBe('a');
    await act(async () => {
      await result.current.deleteSession('a');
    });
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    expect(result.current.currentId).toBe('b');
    expect(m.deleteCalls).toContain('a');
  });
});
