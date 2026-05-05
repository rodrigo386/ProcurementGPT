// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FollowupChips } from '@/components/chat/FollowupChips';

describe('FollowupChips', () => {
  it('renders one button per followup', () => {
    render(<FollowupChips followups={['A?', 'B?', 'C?']} onPick={() => {}} />);
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(screen.getByText('A?')).toBeTruthy();
  });

  it('renders nothing when followups is empty', () => {
    const { container } = render(<FollowupChips followups={[]} onPick={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when disabled', () => {
    const { container } = render(<FollowupChips followups={['A?']} onPick={() => {}} disabled />);
    expect(container.firstChild).toBeNull();
  });

  it('calls onPick with chip text on click', () => {
    const onPick = vi.fn();
    render(<FollowupChips followups={['Hello?', 'World?']} onPick={onPick} />);
    fireEvent.click(screen.getByText('Hello?'));
    expect(onPick).toHaveBeenCalledWith('Hello?');
  });

  it('exposes aria-label "Follow-up sugerido" per chip', () => {
    render(<FollowupChips followups={['X?']} onPick={() => {}} />);
    expect(screen.getByLabelText('Follow-up sugerido: X?')).toBeTruthy();
  });
});
