export type JobStatus = 'queued' | 'running' | 'done' | 'error';
export type JobStage =
  | 'parsing'
  | 'chunking'
  | 'embedding'
  | 'inserting'
  | 'deduplicated'
  | null;

export type IngestJob = {
  id: string;
  user_id: string;
  filename: string;
  storage_path: string;
  size_bytes: number;
  mime_type: string;
  status: JobStatus;
  stage: JobStage;
  progress: number;
  chunks_count: number | null;
  article_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};
