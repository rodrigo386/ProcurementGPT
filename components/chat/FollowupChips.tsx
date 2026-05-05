'use client';

type Props = {
  followups: string[];
  onPick: (text: string) => void;
  disabled?: boolean;
};

export function FollowupChips({ followups, onPick, disabled }: Props) {
  if (disabled) return null;
  if (!followups || followups.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {followups.map((text, i) => (
        <button
          key={`${i}-${text}`}
          type="button"
          onClick={() => onPick(text)}
          aria-label={`Follow-up sugerido: ${text}`}
          className="rounded-full border border-border bg-background px-3 py-1.5 text-xs text-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary transition-colors"
        >
          {text}
        </button>
      ))}
    </div>
  );
}
