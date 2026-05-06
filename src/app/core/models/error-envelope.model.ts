import type { ApiMeta } from './api-meta.model';

export interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  meta: ApiMeta;
  error: ErrorBody;
}
