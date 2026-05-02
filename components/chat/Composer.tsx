'use client';

import { type FormEvent, type KeyboardEvent, useCallback } from 'react';
import { Send, StopCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

type Props = {
  input: string;
  onChange: (value: string) => void;
  onSubmit: (e?: FormEvent) => void;
  isLoading: boolean;
  onStop: () => void;
};

export function Composer({ input, onChange, onSubmit, isLoading, onStop }: Props) {
  const submit = useCallback(
    (e?: FormEvent) => {
      e?.preventDefault();
      if (!input.trim() || isLoading) return;
      onSubmit(e);
    },
    [input, isLoading, onSubmit],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [submit],
  );

  return (
    <form
      onSubmit={submit}
      className="border-t border-border p-4 pb-[max(env(safe-area-inset-bottom),1rem)] bg-background"
    >
      <div className="flex gap-2 items-end max-w-3xl mx-auto">
        <Textarea
          value={input}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Pergunte algo sobre teorias de procurement…"
          rows={1}
          className="resize-none max-h-32 overflow-y-auto"
        />
        {isLoading ? (
          <Button
            type="button"
            onClick={onStop}
            aria-label="Parar geração"
            variant="outline"
            size="icon"
          >
            <StopCircle className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            type="submit"
            aria-label="Enviar"
            disabled={!input.trim()}
            size="icon"
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </form>
  );
}
