// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Message } from '@/components/chat/Message';

describe('Message', () => {
  it('renders user message as plain text', () => {
    render(<Message role="user" content="**não** deve renderizar markdown" isStreaming={false} />);
    // The literal stars should be visible (not interpreted)
    expect(screen.getByText(/\*\*não\*\* deve renderizar/)).toBeTruthy();
  });

  it('renders assistant markdown (heading + bullet) as DOM', () => {
    const md = `# título\n\n- item um\n- item dois`;
    const { container } = render(<Message role="assistant" content={md} isStreaming={false} />);
    expect(screen.getByRole('heading', { level: 1, name: /título/ })).toBeTruthy();
    const prose = container.querySelector('.prose');
    const items = prose?.querySelectorAll('li') || [];
    expect(Array.from(items).map((li) => li.textContent)).toEqual(['item um', 'item dois']);
  });

  it('shows pulsing dot only while streaming on the last assistant bubble', () => {
    const { container, rerender } = render(
      <Message role="assistant" content="texto" isStreaming={true} />,
    );
    expect(container.querySelector('[data-streaming-dot]')).toBeTruthy();
    rerender(<Message role="assistant" content="texto" isStreaming={false} />);
    expect(container.querySelector('[data-streaming-dot]')).toBeFalsy();
  });
});
