import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { StaffRoleService } from '../merchants/staff-role.service';
import { TxnDetail, TxnExport, TxnFlow, TxnListResponse, TxnNote } from './transactions';

/** Filters sent to the list and export APIs (empty values are left out). */
export type TxnQuery = Record<string, string | number | null | undefined>;

/** Global Platform → Transactions API (internal staff). */
@Injectable({ providedIn: 'root' })
export class TransactionsApi {
  private readonly http = inject(HttpClient);
  private readonly roles = inject(StaffRoleService);

  /** PROTOTYPE ONLY: the team the admin login is viewing as. The server ignores it for every other login. */
  private headers() {
    return new HttpHeaders({ 'X-Demo-Role': this.roles.acting() });
  }

  list(flow: TxnFlow, query: TxnQuery) {
    return firstValueFrom(this.http.get<TxnListResponse>(`/api/transactions/${flow}`, { params: toParams(query), headers: this.headers() }));
  }

  exportCsv(flow: TxnFlow, query: TxnQuery) {
    const { page: _p, pageSize: _s, ...filters } = query;
    return firstValueFrom(this.http.get<TxnExport>(`/api/transactions/${flow}/export`, { params: toParams(filters), headers: this.headers() }));
  }

  detail(flow: TxnFlow, id: string) {
    return firstValueFrom(this.http.get<TxnDetail>(`/api/transactions/${flow}/${encodeURIComponent(id)}`, { headers: this.headers() }));
  }

  addNote(flow: TxnFlow, id: string, text: string) {
    return firstValueFrom(this.http.post<TxnNote>(`/api/transactions/${flow}/${encodeURIComponent(id)}/notes`, { text }, { headers: this.headers() }));
  }

  flag(flow: TxnFlow, id: string, reason: string, ticket: string) {
    return firstValueFrom(this.http.post(`/api/transactions/${flow}/${encodeURIComponent(id)}/flag`, { reason, ticket }, { headers: this.headers() }));
  }

  clearFlag(flow: TxnFlow, id: string, resolution: string) {
    return firstValueFrom(this.http.post(`/api/transactions/${flow}/${encodeURIComponent(id)}/flag/clear`, { resolution }, { headers: this.headers() }));
  }
}

export function toParams(query: TxnQuery): HttpParams {
  let p = new HttpParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
  }
  return p;
}
