import type { Classification, RetrievedChunk, SourceRef } from './types';

const PERSONA = `Você é um especialista sênior em procurement com 20 anos de experiência, formação acadêmica sólida (Kraljic, Porter, Monczka, Cox, Cousins, Dyer), didático mas direto. Fundamenta as respostas no conteúdo da base de conhecimento.`;

const RESPONSE_STRUCTURE = `Estrutura padrão de resposta:
1. Resposta direta (2-3 linhas)
2. Aprofundamento teórico baseado no contexto fornecido
3. Aplicação prática (exemplo ou caso curto)`;

const REFUSAL_INSTRUCTION = `Você não tem fonte na base sobre esta pergunta. Diga isso explicitamente em uma frase. Não invente teoria, autor, framework, citação ou data. Você pode fazer uma pergunta de esclarecimento se ajudar a localizar uma teoria mencionada.`;

const GROUNDING_INSTRUCTION = `Use o contexto abaixo para fundamentar sua resposta. NÃO mencione fontes, IDs, números entre colchetes (estilo [1], [2]) ou referências bibliográficas — responda como uma explicação fluente e direta. Se uma afirmação não tiver respaldo no contexto, omita-a.`;

const LANGUAGE_HINT_PT = `Responda em português brasileiro, em tom profissional mas acessível.`;
const LANGUAGE_HINT_EN = `Respond in English, in a professional but accessible tone.`;

export function buildPrompt(
  query: string,
  chunks: RetrievedChunk[],
  classification: Classification,
): { system: string; user: string; sources: SourceRef[] } {
  const sources: SourceRef[] = chunks.map((c, i) => ({
    number: i + 1,
    articleId: c.articleId,
    articleTitle: c.articleTitle,
    chunkId: c.chunkId,
  }));

  const languageHint = classification.language === 'en' ? LANGUAGE_HINT_EN : LANGUAGE_HINT_PT;
  const contextInstruction = chunks.length === 0 ? REFUSAL_INSTRUCTION : GROUNDING_INSTRUCTION;

  const system = [PERSONA, RESPONSE_STRUCTURE, contextInstruction, languageHint].join('\n\n');

  const userParts: string[] = [];
  if (chunks.length > 0) {
    userParts.push('## Contexto da base de conhecimento');
    chunks.forEach((c) => {
      userParts.push(`### ${c.articleTitle}\n\n${c.content}`);
    });
    userParts.push('---');
  }
  userParts.push('## Pergunta do usuário');
  userParts.push(query);

  return { system, user: userParts.join('\n\n'), sources };
}
