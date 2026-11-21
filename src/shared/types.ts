export type JobStatus = "uploaded" | "running" | "transcribed" | "done" | "failed";

export interface Job {
  id: string;
  title: string;
  status: JobStatus;
  error: string | null;
  file_name: string;
  size: number;
  speaker_count_hint: number | null;
  context: string;
  use_correction: number;
  usage: string | null;
  created_at: number;
  updated_at: number;
}

export interface UploadInit {
  key: string;
  uploadId: string;
  partSize: number;
  partCount: number;
}

export interface SignedPart {
  partNumber: number;
  url: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}
