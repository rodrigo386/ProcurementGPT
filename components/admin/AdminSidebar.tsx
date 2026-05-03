'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Users, FileText, Upload, ArrowLeft } from 'lucide-react';

const ITEMS = [
  { href: '/admin/users', label: 'Usuários', Icon: Users },
  { href: '/admin/articles', label: 'Artigos', Icon: FileText },
  { href: '/admin/ingest', label: 'Ingestão', Icon: Upload },
];

export function AdminSidebar() {
  const pathname = usePathname();
  return (
    <aside className="w-52 shrink-0 border-r border-border bg-card flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border">
        <span className="text-sm font-semibold tracking-tight">Admin</span>
      </div>
      <nav className="flex-1 p-2 space-y-1">
        {ITEMS.map(({ href, label, Icon }) => {
          const active = pathname === href || pathname?.startsWith(href + '/');
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                active
                  ? 'bg-primary/10 text-foreground font-medium'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="p-2 border-t border-border">
        <Link
          href="/chat"
          className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Voltar ao chat</span>
        </Link>
      </div>
    </aside>
  );
}
