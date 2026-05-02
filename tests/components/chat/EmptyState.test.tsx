// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmptyState } from '@/components/chat/EmptyState';

describe('EmptyState', () => {
  it('clicking a card calls onPick with the matching query', async () => {
    const onPick = vi.fn();
    render(<EmptyState onPick={onPick} />);
    const user = userEvent.setup();
    const definir = screen.getByRole('button', { name: /definir/i });
    await user.click(definir);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('O que é a matriz de Kraljic?');
  });
});
