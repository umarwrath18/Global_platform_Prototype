import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { ApiErrorBody } from '../api/models';
import { AuthService } from './auth.service';

/** Endpoints that are used before a session exists; a 401/403 there is a form error, not a sign-out. */
const PUBLIC_ENDPOINTS = ['/api/auth/login', '/api/auth/password/'];

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const isPublic = PUBLIC_ENDPOINTS.some((p) => req.url.startsWith(p));
  const token = auth.token;
  const authReq = token && !isPublic ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(authReq).pipe(
    catchError((e: unknown) => {
      if (!isPublic && e instanceof HttpErrorResponse && e.status === 401) {
        auth.handleUnauthenticated((e.error as ApiErrorBody | null)?.code ?? 'SESSION_EXPIRED');
      }
      return throwError(() => e);
    }),
  );
};
