import { Injectable, computed, signal } from '@angular/core';

export type DateRange = '7d' | '30d' | '90d' | 'all';

export const DATE_RANGE_LABEL: Record<DateRange, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All time',
};

interface FilterState {
  country: string;
  merchantId: string;
  currency: string;
  range: DateRange;
}

const KEY = 'mobi.gp.globalFilters';
const EMPTY: FilterState = { country: '', merchantId: '', currency: '', range: 'all' };
const DAY = 24 * 60 * 60_000;

/** Top-bar filters (Country, Merchant, Currency, Date range) applied to merchant onboarding data. */
@Injectable({ providedIn: 'root' })
export class GlobalFilters {
  private readonly state = signal<FilterState>(this.read());

  readonly country = computed(() => this.state().country);
  readonly merchantId = computed(() => this.state().merchantId);
  readonly currency = computed(() => this.state().currency);
  readonly range = computed(() => this.state().range);
  readonly active = computed(() => {
    const s = this.state();
    return !!(s.country || s.merchantId || s.currency || s.range !== 'all');
  });

  set<K extends keyof FilterState>(key: K, value: FilterState[K]) {
    this.state.update((s) => ({ ...s, [key]: value }));
    this.write();
  }

  clear() {
    this.state.set({ ...EMPTY });
    this.write();
  }

  /** Earliest timestamp inside the selected date range (0 for all time). */
  since(now = Date.now()): number {
    const r = this.state().range;
    return r === 'all' ? 0 : now - Number(r.replace('d', '')) * DAY;
  }

  /** True when an application passes every active filter. Dates use the last update. */
  matches(a: { country: string; currency: string; merchantId: string; updatedAt: number }): boolean {
    const s = this.state();
    return (!s.country || a.country === s.country) && (!s.currency || a.currency === s.currency) && (!s.merchantId || a.merchantId === s.merchantId) && a.updatedAt >= this.since();
  }

  private read(): FilterState {
    try {
      return { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
    } catch {
      return { ...EMPTY };
    }
  }

  private write() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state()));
    } catch {
      // Filters still apply for this page load.
    }
  }
}
