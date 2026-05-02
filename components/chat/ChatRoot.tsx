'use client';

import { useState } from 'react';
import { useChatSessions } from '@/hooks/useChatSessions';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { ChatSession } from './ChatSession';
import { Sheet, SheetContent } from '@/components/ui/sheet';

export function ChatRoot() {
  const sessionsApi = useChatSessions();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // useChatSessions starts empty during SSR / first paint and hydrates from
  // localStorage in a useEffect. Render an empty shell until current exists
  // to avoid passing undefined into ChatSession.
  if (!sessionsApi.current) {
    return <div className="h-screen bg-background" />;
  }

  return (
    <div className="flex h-screen bg-background text-foreground">
      <div className="hidden md:flex">
        <Sidebar
          sessions={sessionsApi.sessions}
          currentId={sessionsApi.currentId}
          onSwitch={sessionsApi.switchTo}
          onNew={sessionsApi.createNew}
          onDelete={sessionsApi.deleteSession}
        />
      </div>
      <Sheet open={drawerOpen} onOpenChange={(open) => setDrawerOpen(open)}>
        <SheetContent side="left" className="p-0 w-72">
          <Sidebar
            sessions={sessionsApi.sessions}
            currentId={sessionsApi.currentId}
            onSwitch={(id) => {
              sessionsApi.switchTo(id);
              setDrawerOpen(false);
            }}
            onNew={() => {
              sessionsApi.createNew();
              setDrawerOpen(false);
            }}
            onDelete={sessionsApi.deleteSession}
          />
        </SheetContent>
      </Sheet>
      <div className="flex-1 flex flex-col min-w-0">
        <Header onOpenSidebar={() => setDrawerOpen(true)} />
        <ChatSession
          key={sessionsApi.currentId}
          session={sessionsApi.current}
          onMessagesChange={sessionsApi.updateMessages}
        />
      </div>
    </div>
  );
}
