import { HttpErrorResponse } from '@angular/common/http';
import { ApiErrorBody } from './models';

export type ClientError = ApiErrorBody | { code: 'NETWORK_ERROR' } | { code: 'UNKNOWN_ERROR' };

export function toClientError(e: unknown): ClientError {
  if (e instanceof HttpErrorResponse) {
    if (e.status === 0) return { code: 'NETWORK_ERROR' };
    if (e.error && typeof e.error === 'object' && 'code' in e.error) return e.error as ApiErrorBody;
    if (e.status >= 500) return { code: 'SERVICE_UNAVAILABLE' };
  }
  return { code: 'UNKNOWN_ERROR' };
}

export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.ceil(totalSec));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.ceil(s / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

export function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.ceil(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
