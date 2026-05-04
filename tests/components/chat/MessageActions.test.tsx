// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageActions } from '@/components/chat/MessageActions';

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  toastError.mockReset();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = ORIGINAL_FETCH;
});

const PROPS = {
  traceId: 'tr-1',
  sessionId: '11111111-1111-1111-1111-111111111111',
};

describe('<MessageActions/>', () => {
  it('renders a thumbs-up and thumbs-down button', () => {
    render(<MessageActions {...PROPS} />);
    expect(screen.getByRole('button', { name: 'Resposta útil' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Resposta não útil' })).toBeDefined();
  });

  it('renders the up button as active when initialRating is "up"', () => {
    render(<MessageActions {...PROPS} initialRating="up" />);
    const up = screen.getByRole('button', { name: 'Resposta útil' });
    expect(up.getAttribute('aria-pressed')).toBe('true');
  });

  it('POSTs rating up on thumbs-up click', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
    globalThis.fetch = fetchSpy;
    render(<MessageActions {...PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Resposta útil' }));

    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('/api/feedback');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      sessionId: PROPS.sessionId,
      traceId: PROPS.traceId,
      rating: 'up',
    });
  });

  it('opens a comment textarea on thumbs-down click and submits update with comment', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
    globalThis.fetch = fetchSpy;
    render(<MessageActions {...PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Resposta não útil' }));

    const firstBody = JSON.parse(
      ((fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(firstBody.rating).toBe('down');
    expect(firstBody.comment).toBeUndefined();

    const textarea = await screen.findByRole('textbox');
    await userEvent.type(textarea, 'fora do tema');
    await userEvent.click(screen.getByRole('button', { name: /enviar/i }));

    const secondBody = JSON.parse(
      ((fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1] as RequestInit).body as string,
    );
    expect(secondBody.rating).toBe('down');
    expect(secondBody.comment).toBe('fora do tema');
  });

  it('reverts and toasts on a non-2xx response', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 500 })) as typeof fetch;
    render(<MessageActions {...PROPS} />);
    const up = screen.getByRole('button', { name: 'Resposta útil' });
    await userEvent.click(up);
    await new Promise((r) => setTimeout(r, 50));

    expect(toastError).toHaveBeenCalled();
    expect(up.getAttribute('aria-pressed')).toBe('false');
  });
});
