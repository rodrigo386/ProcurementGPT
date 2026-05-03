export type ExtractedMetadata = {
  title: string;
  author: string | null;
  language: 'pt' | 'en';
  date: string | null; // ISO yyyy-mm-dd
};

const PT_STOPWORDS = new Set([
  'o','a','de','que','e','do','da','em','para','com','um','uma','os','as','dos','das','no','na','não','é',
]);
const EN_STOPWORDS = new Set([
  'the','of','and','to','in','that','for','with','is','it','as','on','by','this','an','are','at','be','or',
]);

function titleFromFilename(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, '');
  return stem.replace(/[_\-]+/g, ' ').trim();
}

export function extractMetadata(text: string, filename: string): ExtractedMetadata {
  const head = text.slice(0, 500);

  const firstLine = (text.split('\n').find((l) => l.trim()) ?? '').trim();
  const looksLikeTitle =
    firstLine.length >= 10 &&
    firstLine.length <= 200 &&
    !/[.!?]$/.test(firstLine);
  const title = looksLikeTitle ? firstLine : titleFromFilename(filename);

  const authorMatch = head.match(/^(?:Autor|Author|By|Por)[:\s]+([^\n]+)$/im);
  const author = authorMatch ? authorMatch[1]!.trim() : null;

  const sample = text.slice(0, 1500).toLowerCase();
  const tokens = sample.match(/\b[\p{L}']+\b/gu) ?? [];
  let pt = 0;
  let en = 0;
  for (const t of tokens) {
    if (PT_STOPWORDS.has(t)) pt++;
    if (EN_STOPWORDS.has(t)) en++;
  }
  const language: 'pt' | 'en' = en > pt ? 'en' : 'pt';

  const dateMatch = head.match(/\b(20\d{2})\b/);
  const date = dateMatch ? `${dateMatch[1]}-01-01` : null;

  return { title, author, language, date };
}
