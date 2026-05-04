export type TraceLevel = 'DEFAULT' | 'WARNING' | 'ERROR';

export interface Span {
  end(output?: unknown, level?: TraceLevel): void;
}

export interface Trace {
  id: string;
  span(name: string, input?: unknown): Span;
  end(output?: unknown, level?: TraceLevel): void;
  setMetadata(key: string, value: unknown): void;
  setTag(tag: string): void;
}
