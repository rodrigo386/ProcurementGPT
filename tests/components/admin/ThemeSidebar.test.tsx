// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ThemeSidebar } from '@/components/admin/ThemeSidebar';
import { TAXONOMY } from '@/lib/ingest/taxonomy';

afterEach(() => cleanup());

const articles = [
  { theme: 'Kraljic' },
  { theme: 'Kraljic' },
  { theme: 'TCO' },
  { theme: 'Outros' },
] as Array<{ theme: string }>;

describe('ThemeSidebar', () => {
  it('renders Todos + 11 themes (12 buttons total)', () => {
    render(<ThemeSidebar articles={articles} selected="all" onSelect={() => {}} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(12);
  });

  it('shows correct counts per theme', () => {
    render(<ThemeSidebar articles={articles} selected="all" onSelect={() => {}} />);
    expect(screen.getByText('Todos').closest('button')?.textContent).toContain('4');
    expect(screen.getByText('Kraljic').closest('button')?.textContent).toContain('2');
    expect(screen.getByText('TCO').closest('button')?.textContent).toContain('1');
    expect(screen.getByText('Outros').closest('button')?.textContent).toContain('1');
    // Themes with 0 articles still render with count 0
    expect(screen.getByText('SRM').closest('button')?.textContent).toContain('0');
  });

  it('marks the selected theme as active (aria-current)', () => {
    render(<ThemeSidebar articles={articles} selected="Kraljic" onSelect={() => {}} />);
    const kraljic = screen.getByText('Kraljic').closest('button');
    expect(kraljic?.getAttribute('aria-current')).toBe('true');
    const todos = screen.getByText('Todos').closest('button');
    expect(todos?.getAttribute('aria-current')).toBeFalsy();
  });

  it('fires onSelect with the clicked theme', () => {
    const onSelect = vi.fn();
    render(<ThemeSidebar articles={articles} selected="all" onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Kraljic').closest('button')!);
    expect(onSelect).toHaveBeenCalledWith('Kraljic');
    fireEvent.click(screen.getByText('Todos').closest('button')!);
    expect(onSelect).toHaveBeenCalledWith('all');
  });

  it('renders all TAXONOMY themes in order', () => {
    render(<ThemeSidebar articles={[]} selected="all" onSelect={() => {}} />);
    for (const t of TAXONOMY) {
      expect(screen.getByText(t)).toBeTruthy();
    }
  });
});
