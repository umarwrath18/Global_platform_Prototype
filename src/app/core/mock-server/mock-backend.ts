import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { from, mergeMap, Observable, timer } from 'rxjs';
import { DemoInboxService } from '../../shared/demo-inbox.service';
import { AuthServer } from './auth-server';

/**
 * Hosts the simulated backend for the prototype and exposes QA hooks on
 * `window.mobiDemo`. Remove this provider and the interceptor when the real API is connected.
 */
@Injectable({ providedIn: 'root' })
export class MockBackend {
  private readonly inbox = inject(DemoInboxService);

  readonly server = new AuthServer({
    storage: localStorage,
    sendEmail: (email) => this.inbox.deliver(email),
  });

  constructor() {
    (window as any).mobiDemo = {
      suspendAccount: (id: string) => this.server.setAccountStatus(id, 'suspended'),
      reactivateAccount: (id: string) => this.server.setAccountStatus(id, 'active'),
      disableUser: (loginId: string) => this.server.setUserStatus(loginId, 'disabled'),
      enableUser: (loginId: string) => this.server.setUserStatus(loginId, 'active'),
      expireSessions: () => this.server.expireSessions(),
      audit: async () => console.table((await this.server.auditLog()).map((e) => ({ ...e, at: new Date(e.at).toISOString() }))),
      reset: () => this.server.resetAll(),
    };
  }
}

const LATENCY_MS = 450;

export const mockBackendInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/')) return next(req);
  const backend = inject(MockBackend);

  return new Observable<HttpResponse<unknown>>((subscriber) => {
    if (!navigator.onLine) {
      subscriber.error(new HttpErrorResponse({ status: 0, statusText: 'Unknown Error', url: req.url }));
      return;
    }
    const token = req.headers.get('Authorization')?.replace(/^Bearer /, '') ?? null;
    const sub = timer(LATENCY_MS)
      .pipe(mergeMap(() => from(backend.server.handle(req.method, req.urlWithParams, req.body, token))))
      .subscribe({
        next: (res) => {
          if (res.status < 400) {
            subscriber.next(new HttpResponse({ status: res.status, body: res.body, url: req.url }));
            subscriber.complete();
          } else {
            subscriber.error(new HttpErrorResponse({ status: res.status, error: res.body, url: req.url }));
          }
        },
        error: (e) => subscriber.error(new HttpErrorResponse({ status: 500, error: { code: 'SERVICE_UNAVAILABLE' }, url: req.url, statusText: String(e) })),
      });
    return () => sub.unsubscribe();
  });
};
