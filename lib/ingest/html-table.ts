export type TableRange = { start: number; end: number; html: string };

/**
 * Locate top-level <table>...</table> ranges in an HTML string.
 * Nested tables are not returned as separate ranges (they live inside
 * the outermost table's html). The returned ranges are ordered by start
 * offset so callers can interleave with text spans between them.
 */
export function extractTables(html: string): TableRange[] {
  const out: TableRange[] = [];
  const lower = html.toLowerCase();
  let i = 0;
  while (i < lower.length) {
    const open = lower.indexOf('<table', i);
    if (open === -1) break;
    // Find the matching </table> at depth 0.
    let depth = 1;
    let j = lower.indexOf('>', open);
    if (j === -1) break;
    j += 1;
    while (j < lower.length && depth > 0) {
      const nextOpen = lower.indexOf('<table', j);
      const nextClose = lower.indexOf('</table>', j);
      if (nextClose === -1) return out; // malformed — bail
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        j = lower.indexOf('>', nextOpen) + 1;
      } else {
        depth -= 1;
        j = nextClose + '</table>'.length;
      }
    }
    out.push({ start: open, end: j, html: html.slice(open, j) });
    i = j;
  }
  return out;
}

function stripTags(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

/** Extract `<tr>...</tr>` rows from a table HTML string (top-level only). */
function extractRows(tableHtml: string): string[] {
  const rows: string[] = [];
  const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tableHtml)) !== null) {
    rows.push(m[1] ?? '');
  }
  return rows;
}

/** Extract `<th>` / `<td>` cells from a row HTML string. */
function extractCells(rowHtml: string): string[] {
  const cells: string[] = [];
  const re = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowHtml)) !== null) {
    cells.push(escapeCell(stripTags(m[1] ?? '')));
  }
  return cells;
}

export function htmlTableToMarkdown(tableHtml: string): string {
  const rows = extractRows(tableHtml).map(extractCells).filter((r) => r.length > 0);
  if (rows.length === 0) return '';
  const header = rows[0];
  if (!header) return '';
  const body = rows.slice(1);
  const divider = header.map(() => '---');
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${divider.join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}
