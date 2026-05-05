export type Intent =
  | 'definition'
  | 'application'
  | 'comparison'
  | 'recommendation'
  | 'smalltalk';

export type Classification = {
  theory: string | null;
  intent: Intent;
  language: 'pt' | 'en';
  needsRetrieval: boolean;
};

export type RetrievedChunk = {
  chunkId: string;
  articleId: string;
  content: string;
  ord: number;
  articleTitle: string;
  vectorRank: number | null;
  ftsRank: number | null;
  rrfScore: number;
  rerankScore: number | null;
};

export type SourceRef = {
  number: number;
  articleId: string;
  articleTitle: string;
  chunkId: string;
};

export type RagDebug = {
  classifyMs: number;
  embedMs: number;
  vectorMs: number;
  ftsMs: number;
  rerankMs: number;
  totalMs: number;
};

export type RagResult = {
  classification: Classification;
  chunks: RetrievedChunk[];
  sources: SourceRef[];
  system: string;
  user: string;
  debug: RagDebug;
};

export const SAFE_DEFAULT_CLASSIFICATION: Classification = {
  theory: null,
  intent: 'definition',
  language: 'pt',
  needsRetrieval: true,
};

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};
