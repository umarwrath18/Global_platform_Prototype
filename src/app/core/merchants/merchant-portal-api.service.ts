import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TxnFlow } from '../transactions/transactions';
import { toParams, TxnQuery } from '../transactions/transactions-api.service';
import { DatePreset, MerchantPortalOverview, MerchantSettingsView, TransactionDetail, TransactionExport, TransactionPage, TransactionSummary } from './merchant-portal';

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

  /** My Transactions: one flow at a time (`flow` = payin or payout). */
  transactions(flow: TxnFlow, query: TxnQuery) {
    return firstValueFrom(this.http.get<TransactionPage>('/api/merchant-portal/transactions', { params: toParams({ ...query, flow }) }));
  }

  transaction(flow: TxnFlow, id: string) {
    return firstValueFrom(this.http.get<TransactionDetail>(`/api/merchant-portal/transactions/${flow}/${encodeURIComponent(id)}`));
  }

  exportCsv(flow: TxnFlow, query: TxnQuery) {
    const { page: _p, pageSize: _s, ...filters } = query;
    return firstValueFrom(this.http.get<TransactionExport>('/api/merchant-portal/transactions/export', { params: toParams({ ...filters, flow }) }));
  }
}
