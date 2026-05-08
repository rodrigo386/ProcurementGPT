'use client';

import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';

type Props = { onJobsCreated: (jobIds: string[]) => void };

const ALLOWED = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]);
const MAX_MB = 100;
const MAX_BYTES = MAX_MB * 1024 * 1024;

async function uploadOne(file: File): Promise<string | null> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/admin/ingest/upload', { method: 'POST', body: fd });
  if (!res.ok) return null;
  const body = (await res.json()) as { jobId: string };
  // Fire-and-forget: trigger pipeline; do NOT await.
  void fetch(`/api/admin/ingest/run/${body.jobId}`, { method: 'POST' });
  return body.jobId;
}

export function Dropzone({ onJobsCreated }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hover, setHover] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  async function handleFiles(files: FileList | File[]) {
    const arr = Array.from(files);
    const errs: string[] = [];
    const valid: File[] = [];
    for (const f of arr) {
      if (!ALLOWED.has(f.type)) {
        errs.push(`${f.name}: tipo não suportado`);
        continue;
      }
      if (f.size > MAX_BYTES) {
        errs.push(`${f.name}: maior que ${MAX_MB} MB`);
        continue;
      }
      valid.push(f);
    }
    setErrors(errs);
    if (valid.length === 0) return;
    const jobIds: string[] = [];
    for (const f of valid) {
      const id = await uploadOne(f);
      if (id) jobIds.push(id);
    }
    if (jobIds.length > 0) onJobsCreated(jobIds);
  }

  return (
    <div className="space-y-2">
      <div
        data-testid="dropzone"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={(e) => {
          e.preventDefault();
          setHover(false);
          if (e.dataTransfer?.files) handleFiles(e.dataTransfer.files);
        }}
        className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition-colors ${
          hover ? 'border-primary bg-primary/5' : 'border-border bg-card hover:border-primary/50'
        }`}
      >
        <Upload className="h-7 w-7 text-muted-foreground" />
        <div className="text-sm font-medium">Arraste arquivos aqui ou clique para selecionar</div>
        <div className="text-xs text-muted-foreground">PDF, DOCX, TXT — máx {MAX_MB} MB por arquivo</div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
      </div>
      {errors.map((err, i) => (
        <p key={i} className="text-xs text-destructive">{err}</p>
      ))}
    </div>
  );
}
