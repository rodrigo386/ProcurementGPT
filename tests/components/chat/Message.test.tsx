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

  it('renders followup chips on last assistant message when not streaming', () => {
    const { container } = render(
      <Message
        role="assistant"
        content="resposta"
        isStreaming={false}
        isLast
        followups={['A?', 'B?']}
        onPickFollowup={() => {}}
      />,
    );
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(2);
  });

  it('does NOT render chips when not last', () => {
    const { container } = render(
      <Message
        role="assistant"
        content="r"
        isStreaming={false}
        isLast={false}
        followups={['A?']}
        onPickFollowup={() => {}}
      />,
    );
    expect(container.querySelectorAll('button').length).toBe(0);
  });

  it('does NOT render chips while streaming', () => {
    const { container } = render(
      <Message
        role="assistant"
        content="r"
        isStreaming={true}
        isLast
        followups={['A?']}
        onPickFollowup={() => {}}
      />,
    );
    expect(container.querySelectorAll('button').length).toBe(0);
  });

  it('does NOT render chips for user role', () => {
    const { container } = render(
      <Message
        role="user"
        content="r"
        isStreaming={false}
        isLast
        followups={['A?']}
        onPickFollowup={() => {}}
      />,
    );
    expect(container.querySelectorAll('button').length).toBe(0);
  });
});
