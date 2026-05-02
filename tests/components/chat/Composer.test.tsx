// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from '@/components/chat/Composer';

function setup(props?: Partial<React.ComponentProps<typeof Composer>>) {
  const onChange = vi.fn();
  const onSubmit = vi.fn((e?: { preventDefault?: () => void }) => e?.preventDefault?.());
  const onStop = vi.fn();
  const all = {
    input: '',
    onChange,
    onSubmit,
    isLoading: false,
    onStop,
    ...props,
  } as React.ComponentProps<typeof Composer>;
  const utils = render(<Composer {...all} />);
  return { ...utils, onChange, onSubmit, onStop };
}

afterEach(() => {
  cleanup();
});

describe('Composer', () => {
  it('Enter submits when input is non-empty and not loading', async () => {
    const { onSubmit } = setup({ input: 'oi' });
    const ta = screen.getByPlaceholderText(/pergunte/i);
    const user = userEvent.setup();
    ta.focus();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Shift+Enter inserts a newline and does NOT submit', async () => {
    const { onSubmit, onChange } = setup({ input: 'oi' });
    const ta = screen.getByPlaceholderText(/pergunte/i);
    const user = userEvent.setup();
    ta.focus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSubmit).not.toHaveBeenCalled();
    // onChange fired with the newline appended
    expect(onChange).toHaveBeenCalled();
  });

  it('while isLoading, the action button shows stop and calls onStop', async () => {
    const { onStop, onSubmit } = setup({ input: 'oi', isLoading: true });
    const stop = screen.getByRole('button', { name: /parar/i });
    const user = userEvent.setup();
    await user.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
