import { describe, expect, it } from 'vitest';
import { htmlTableToMarkdown, extractTables } from '@/lib/ingest/html-table';

describe('htmlTableToMarkdown', () => {
  it('converts simple 2x2 table with header divider', () => {
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
    const md = htmlTableToMarkdown(html);
    expect(md).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('treats first <tr> as header when no <thead>', () => {
    const html = '<table><tr><td>X</td><td>Y</td></tr><tr><td>3</td><td>4</td></tr></table>';
    const md = htmlTableToMarkdown(html);
    expect(md.split('\n')[0]).toBe('| X | Y |');
    expect(md.split('\n')[1]).toBe('| --- | --- |');
  });

  it('escapes pipe characters in cells', () => {
    const html = '<table><tr><td>a|b</td><td>c</td></tr></table>';
    const md = htmlTableToMarkdown(html);
    expect(md).toContain('a\\|b');
  });

  it('replaces <br> in cells with a single space', () => {
    const html = '<table><tr><td>line1<br/>line2</td><td>x</td></tr></table>';
    const md = htmlTableToMarkdown(html);
    expect(md).toContain('line1 line2');
  });

  it('flattens nested <table> in a cell to plain text without re-formatting', () => {
    const html =
      '<table><tr><td>outer1</td><td><table><tr><td>nested</td></tr></table></td></tr></table>';
    const md = htmlTableToMarkdown(html);
    expect(md).toContain('outer1');
    expect(md).toContain('nested');
    expect(md.split('|').filter((s) => s.trim() === 'nested').length).toBe(1);
  });
});

describe('extractTables', () => {
  it('returns ordered list of {start, end, html} ranges for each top-level <table>', () => {
    const html = '<p>before</p><table><tr><td>1</td></tr></table><p>mid</p><table><tr><td>2</td></tr></table><p>after</p>';
    const ranges = extractTables(html);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]?.html).toContain('<td>1</td>');
    expect(ranges[1]?.html).toContain('<td>2</td>');
    expect(ranges[0]?.start ?? -1).toBeLessThan(ranges[1]?.start ?? -1);
  });

  it('skips nested tables — only outermost tables returned', () => {
    const html = '<table><tr><td><table><tr><td>nested</td></tr></table></td></tr></table>';
    const ranges = extractTables(html);
    expect(ranges).toHaveLength(1);
  });
});
