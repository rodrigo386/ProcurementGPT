import { classify } from './classifier';
import { retrieve } from './retriever';
import { rerank } from './reranker';
import { buildPrompt } from './prompt-builder';
import type { RagResult, RetrievedChunk } from './types';
import type { Trace } from '@/lib/observability/types';

const RERANK_TOP_N = 8;

export type RunRagOpts = {
  parentTrace?: Trace;
  /** Internal hook for eval batching: skip embed call if vector already known. */
  _preEmbeddedQuery?: number[];
};

export async function runRag(query: string, opts: RunRagOpts = {}): Promise<RagResult> {
  const t0 = performance.now();
  const trace = opts.parentTrace;

  const tClassifyStart = performance.now();
  const classifySpan = trace?.span('classify', { query });
  const classification = await classify(query);
  classifySpan?.end({ classification });
  const classifyMs = performance.now() - tClassifyStart;

  let chunks: RetrievedChunk[] = [];
  let embedMs = 0;
  let vectorMs = 0;
  let ftsMs = 0;
  let rerankMs = 0;

  if (classification.needsRetrieval) {
    const tRetrieveStart = performance.now();
    const retrieveSpan = trace?.span('retrieve', { query, k: 30 });
    const candidates = await retrieve(query, { preEmbedded: opts._preEmbeddedQuery });
    retrieveSpan?.end({ count: candidates.length });
    const retrieveMs = performance.now() - tRetrieveStart;
    embedMs = retrieveMs;
    vectorMs = retrieveMs;
    ftsMs = retrieveMs;

    const tRerankStart = performance.now();
    const rerankSpan = trace?.span('rerank', { candidates: candidates.length });
    chunks = await rerank(query, candidates, RERANK_TOP_N);
    rerankSpan?.end({ kept: chunks.length });
    rerankMs = performance.now() - tRerankStart;
  }

  const promptSpan = trace?.span('build-prompt', { sources: chunks.length });
  const { system, user, sources } = buildPrompt(query, chunks, classification);
  promptSpan?.end({ systemLen: system.length, userLen: user.length });

  return {
    classification,
    sources,
    system,
    user,
    debug: {
      classifyMs,
      embedMs,
      vectorMs,
      ftsMs,
      rerankMs,
      totalMs: performance.now() - t0,
    },
  };
}

export type { Classification, RetrievedChunk, SourceRef, RagResult } from './types';
