// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatSession } from '@/components/chat/ChatSession';
import type { StoredSession } from '@/lib/chat-storage';

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

const ORIGINAL_FETCH = globalThis.fetch;

function makeSession(): StoredSession {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Test',
    messages: [],
    updatedAt: 0,
  };
}

beforeEach(() => {
  toastError.mockReset();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('<ChatSession/>', () => {
  it('renders an empty state with a textbox when there are no messages', () => {
    render(<ChatSession session={makeSession()} onMessagesChange={() => {}} />);
    expect(screen.getByRole('textbox')).toBeDefined();
  });

  it('shows a friendly toast when /api/chat returns 429', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'rate_limited', retry_after_secs: 120 }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof fetch;

    render(<ChatSession session={makeSession()} onMessagesChange={() => {}} />);
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'oi{enter}');

    // useChat issues fetch async; allow the onResponse callback to flush.
    await new Promise((r) => setTimeout(r, 100));

    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/Limite.*\d+\s*min/i));
  });

  it('shows a generic toast on a 500 response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'chat failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof fetch;

    render(<ChatSession session={makeSession()} onMessagesChange={() => {}} />);
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'oi{enter}');

    await new Promise((r) => setTimeout(r, 100));

    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/problema/i));
  });
});
