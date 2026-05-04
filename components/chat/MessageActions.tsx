'use client';

import { useState } from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import { toast } from 'sonner';

type Rating = 'up' | 'down';

type Props = {
  traceId: string;
  sessionId: string;
  initialRating?: Rating;
};

const COMMENT_MAX = 1000;

async function postFeedback(input: {
  sessionId: string;
  traceId: string;
  rating: Rating;
  comment?: string;
}): Promise<boolean> {
  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function MessageActions({ traceId, sessionId, initialRating }: Props) {
  const [rating, setRating] = useState<Rating | null>(initialRating ?? null);
  const [showComment, setShowComment] = useState(false);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const click = async (next: Rating) => {
    const previous = rating;
    setRating(next);
    if (next === 'down') setShowComment(true);
    else setShowComment(false);

    const ok = await postFeedback({ sessionId, traceId, rating: next });
    if (!ok) {
      setRating(previous);
      setShowComment(previous === 'down');
      toast.error('Não foi possível registrar o feedback. Tente novamente.');
    }
  };

  const submitComment = async () => {
    if (!comment.trim()) {
      setShowComment(false);
      return;
    }
    setSubmitting(true);
    const ok = await postFeedback({
      sessionId,
      traceId,
      rating: 'down',
      comment: comment.slice(0, COMMENT_MAX),
    });
    setSubmitting(false);
    if (!ok) {
      toast.error('Não foi possível registrar o comentário. Tente novamente.');
      return;
    }
    setShowComment(false);
    setComment('');
  };

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => click('up')}
          aria-pressed={rating === 'up'}
          aria-label="Resposta útil"
          title="Resposta boa"
          className={
            rating === 'up'
              ? 'text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }
        >
          <ThumbsUp className="h-4 w-4" fill={rating === 'up' ? 'currentColor' : 'none'} />
        </button>
        <button
          type="button"
          onClick={() => click('down')}
          aria-pressed={rating === 'down'}
          aria-label="Resposta não útil"
          title="Resposta ruim"
          className={
            rating === 'down'
              ? 'text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }
        >
          <ThumbsDown className="h-4 w-4" fill={rating === 'down' ? 'currentColor' : 'none'} />
        </button>
      </div>
      {showComment ? (
        <div className="flex flex-col gap-2 max-w-md">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, COMMENT_MAX))}
            placeholder="O que faltou? (opcional, até 1000 caracteres)"
            className="rounded-md border border-border bg-background p-2 text-sm"
            rows={3}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={submitComment}
              disabled={submitting}
              className="rounded-md bg-primary text-primary-foreground px-3 py-1 text-xs disabled:opacity-50"
            >
              Enviar
            </button>
            <button
              type="button"
              onClick={() => {
                setShowComment(false);
                setComment('');
              }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
