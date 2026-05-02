import { classify } from './classifier';
import { retrieve } from './retriever';
import { rerank } from './reranker';
import { buildPrompt } from './prompt-builder';
import type { RagResult, RetrievedChunk } from './types';

const RERANK_TOP_N = 8;

export async function runRag(query: string): Promise<RagResult> {
  const t0 = performance.now();

  const tClassifyStart = performance.now();
  const classification = await classify(query);
  const classifyMs = performance.now() - tClassifyStart;

  let chunks: RetrievedChunk[] = [];
  let embedMs = 0;
  let vectorMs = 0;
  let ftsMs = 0;
  let rerankMs = 0;

  if (classification.needsRetrieval) {
    const tRetrieveStart = performance.now();
    const candidates = await retrieve(query);
    const retrieveMs = performance.now() - tRetrieveStart;
    embedMs = retrieveMs;
    vectorMs = retrieveMs;
    ftsMs = retrieveMs;

    const tRerankStart = performance.now();
    chunks = await rerank(query, candidates, RERANK_TOP_N);
    rerankMs = performance.now() - tRerankStart;
  }

  const { system, user, sources } = buildPrompt(query, chunks, classification);

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
