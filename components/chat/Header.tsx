'use client';

import { useEffect, useState } from 'react';
import { Menu, Moon, Sun, Monitor, MessageSquareText } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';

// TODO: replace with company-owned address once branding is decided.
const FEEDBACK_MAILTO =
  'mailto:rgoalves@gmail.com?subject=ProcurementGPT%20feedback';

type Props = {
  onOpenSidebar?: () => void;
};

export function Header({ onOpenSidebar }: Props) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const cycle = () => {
    const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    setTheme(next);
  };

  const Icon = !mounted ? Monitor : theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const label = !mounted
    ? 'Tema'
    : theme === 'light'
      ? 'Tema: claro (clique para alternar)'
      : theme === 'dark'
        ? 'Tema: escuro (clique para alternar)'
        : 'Tema: sistema (clique para alternar)';

  return (
    <header className="h-14 border-b border-border bg-background flex items-center justify-between px-4 shrink-0">
      <div className="flex items-center gap-2">
        {onOpenSidebar ? (
          <Button
            size="icon"
            variant="ghost"
            className="md:hidden"
            onClick={onOpenSidebar}
            aria-label="Abrir conversas"
          >
            <Menu className="h-4 w-4" />
          </Button>
        ) : null}
        <span className="text-sm font-semibold md:hidden">ProcurementGPT</span>
      </div>
      <div className="flex items-center gap-1">
        <a
          href={FEEDBACK_MAILTO}
          aria-label="Enviar feedback"
          title="Enviar feedback geral"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
        >
          <MessageSquareText className="h-4 w-4" />
        </a>
        <Button size="icon" variant="ghost" onClick={cycle} aria-label={label} title={label}>
          <Icon className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
