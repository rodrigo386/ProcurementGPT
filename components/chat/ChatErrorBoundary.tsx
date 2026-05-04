'use client';

import React from 'react';

type Props = { children: React.ReactNode };
type State = { hasError: boolean };

export class ChatErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(err: Error) {
    console.error('[chat] render error:', err);
  }

  reset = () => this.setState({ hasError: false });

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full items-center justify-center p-8 text-center text-muted-foreground">
          <div>
            <p className="mb-2">Algo quebrou ao renderizar a conversa.</p>
            <button onClick={this.reset} className="underline">
              Tentar de novo
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
