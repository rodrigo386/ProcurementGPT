// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ChatMessage } from '@/lib/rag/types';

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
  vi.resetModules();
});

describe('useChatSessions', () => {
  it('auto-creates one session on mount when storage is empty and selects it', async () => {
    const { useChatSessions } = await import('@/hooks/useChatSessions');
    const { result } = renderHook(() => useChatSessions());
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.currentId).toBe(result.current.sessions[0]!.id);
    expect(result.current.current.messages).toEqual([]);
  });

  it('createNew adds a session and selects it; old session preserved', async () => {
    const { useChatSessions } = await import('@/hooks/useChatSessions');
    const { result } = renderHook(() => useChatSessions());
    const firstId = result.current.currentId;
    act(() => result.current.createNew());
    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.currentId).not.toBe(firstId);
    expect(result.current.sessions.some((s) => s.id === firstId)).toBe(true);
  });

  it('updateMessages updates the current session and switchTo restores it', async () => {
    const { useChatSessions } = await import('@/hooks/useChatSessions');
    const { result } = renderHook(() => useChatSessions());
    const firstId = result.current.currentId;
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'olá ProcurementGPT' },
      { role: 'assistant', content: 'oi' },
    ];
    act(() => result.current.updateMessages(msgs));
    act(() => result.current.createNew());
    expect(result.current.currentId).not.toBe(firstId);
    act(() => result.current.switchTo(firstId));
    expect(result.current.current.messages).toEqual(msgs);
    // Title derived from first user message
    expect(result.current.current.title).toBe('olá ProcurementGPT');
  });
});
