import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DatePreset, MerchantPortalOverview, MerchantSettingsView, TransactionExport, TransactionPage, TransactionQuery, TransactionSummary } from './merchant-portal';

/** Merchant-facing portal API. The merchant is identified by the session, never by a parameter. */
@Injectable({ providedIn: 'root' })
export class MerchantPortalApi {
  private readonly http = inject(HttpClient);

  /** Read-only pricing, settlement and integration settings for the merchant's live countries. */
  settings() {
    return firstValueFrom(this.http.get<MerchantSettingsView>('/api/merchant-portal/settings'));
  }

  overview() {
    return firstValueFrom(this.http.get<MerchantPortalOverview>('/api/merchant-portal/overview'));
  }

  summary(range: DatePreset) {
    return firstValueFrom(this.http.get<TransactionSummary>('/api/merchant-portal/summary', { params: { range } }));
  }

  transactions(query: TransactionQuery) {
    return firstValueFrom(this.http.get<TransactionPage>('/api/merchant-portal/transactions', { params: toParams(query) }));
  }

  exportCsv(query: TransactionQuery) {
    const { page: _p, pageSize: _s, ...filters } = query;
    return firstValueFrom(this.http.get<TransactionExport>('/api/merchant-portal/transactions/export', { params: toParams(filters) }));
  }
}

function toParams(query: Partial<TransactionQuery>): HttpParams {
  let p = new HttpParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
  }
  return p;
}
