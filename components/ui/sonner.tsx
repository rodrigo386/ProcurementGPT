'use client';

import { Toaster as SonnerToaster } from 'sonner';
import { useTheme } from 'next-themes';

export function Toaster() {
  const { resolvedTheme } = useTheme();
  return (
    <SonnerToaster
      position="top-center"
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast: 'group toast bg-background text-foreground border-border',
        },
      }}
    />
  );
}
