import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { from, mergeMap, Observable, timer } from 'rxjs';
import { DemoInboxService } from '../../shared/demo-inbox.service';
import { AuthServer } from './auth-server';
import { CountryConfigServer } from './country-config-server';
import { MccCatalogueServer } from './mcc-catalogue-server';
import { MCC_STANDARD_LIST, MCC_STANDARD_NAME, MCC_STANDARD_VERSION } from '../merchants/mcc-standard';
import { MerchantPortalServer } from './merchant-portal-server';
import { MerchantServer } from './merchant-server';
import { isStrictValidation, setStrictValidation } from '../merchants/validation-mode';

/**
 * Hosts the simulated backend for the prototype and exposes QA hooks on
 * `window.mobiDemo`. Remove this provider and the interceptor when the real API is connected.
 */
@Injectable({ providedIn: 'root' })
export class MockBackend {
  private readonly inbox = inject(DemoInboxService);

  readonly server: AuthServer = new AuthServer({
    fixedTeams: true,
    storage: localStorage,
    sendEmail: (email) => this.inbox.deliver(email),
    merchantName: (id: string): string | null => this.merchants.portalProfile(id)?.legalName ?? null,
  });

  readonly countryConfig = new CountryConfigServer({ storage: localStorage, auth: this.server });

  readonly mcc = new MccCatalogueServer({
    storage: localStorage,
    auth: this.server,
    defaultCatalogue: { source: { kind: 'standard', name: MCC_STANDARD_NAME, version: MCC_STANDARD_VERSION, loadedAt: 0 }, entries: MCC_STANDARD_LIST },
  });

  readonly merchants: MerchantServer = new MerchantServer({ storage: localStorage, auth: this.server, strictValidation: isStrictValidation, countryConfig: this.countryConfig, mcc: this.mcc, fixedTeams: true });

  /** Merchant-facing portal (sample transactions and balance; see merchant-portal-server.ts). */
  readonly merchantPortal = new MerchantPortalServer({ storage: localStorage, auth: this.server, profile: (id) => this.merchants.portalProfile(id) });

  constructor() {
    (window as any).mobiDemo = {
      suspendAccount: (id: string) => this.server.setAccountStatus(id, 'suspended'),
      reactivateAccount: (id: string) => this.server.setAccountStatus(id, 'active'),
      disableUser: (loginId: string) => this.server.setUserStatus(loginId, 'disabled'),
      enableUser: (loginId: string) => this.server.setUserStatus(loginId, 'active'),
      expireSessions: () => this.server.expireSessions(),
      // 2FA: forget a user's authenticator so first-time setup can be tested again.
      clearAuthenticator: (loginId: string) => this.server.demoClearAuthenticator(loginId),
      audit: async () => console.table((await this.server.auditLog()).map((e) => ({ ...e, at: new Date(e.at).toISOString() }))),
      // Restores the auth, merchant and country configuration demo data.
      reset: async () => {
        await this.server.resetAll();
        await this.merchants.resetAll();
        await this.countryConfig.resetAll();
        this.merchantPortal.resetAll();
      },
      resetMerchants: () => this.merchants.resetAll(),
      // Merchant data upgrade (schema revision 3): status, flagged records, and a manual restore.
      merchantDataReport: () => this.merchants.dataReport(),
      restoreMerchantBackup: () => this.merchants.restoreBackup(),
      resetCountryConfig: () => this.countryConfig.resetAll(),
      // MCC catalogue: empty until loaded on purpose. The test fixture is labelled and is not approved data.
      loadMccTestFixture: () => this.mcc.loadTestFixture(),
      loadMccCatalogue: (entries: unknown, source: { name: string; version: string }) => this.mcc.load(entries, { kind: 'approved', ...source }),
      clearMccCatalogue: () => this.mcc.clear(),
      strictValidation: (on: boolean) => setStrictValidation(on),
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
    const handle = MerchantPortalServer.handles(req.url)
      ? () => backend.merchantPortal.handle(req.method, req.urlWithParams, token)
      : MerchantServer.handles(req.url)
      ? () => backend.merchants.handle(req.method, req.urlWithParams, req.body, token, req.headers.get('X-Demo-Role'))
      : MccCatalogueServer.handles(req.url)
        ? () => backend.mcc.handle(req.method, req.urlWithParams, req.body, token)
        : CountryConfigServer.handles(req.url)
        ? () => backend.countryConfig.handle(req.method, req.urlWithParams, req.body, token, req.headers.get('X-Demo-Role'))
        : () => backend.server.handle(req.method, req.urlWithParams, req.body, token, req.headers.get('X-Demo-Role'));
    const sub = timer(LATENCY_MS)
      .pipe(mergeMap(() => from(handle())))
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
