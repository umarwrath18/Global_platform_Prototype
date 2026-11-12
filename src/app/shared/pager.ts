import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { Icon } from './icon';

/** Rows of a list for the current page. */
export function pageOf<T>(rows: T[], page: number, size: number): T[] {
  const last = Math.max(0, Math.ceil(rows.length / size) - 1);
  const p = Math.min(page, last);
  return rows.slice(p * size, p * size + size);
}

/**
 * The one pager for every long list: "Rows per page", "1–25 of 312", previous / next.
 * Default 25 rows. The host keeps `page` (0-based) and `pageSize`, and slices with pageOf().
 */
@Component({
  selector: 'app-pager',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <nav class="pager" aria-label="Pagination">
      <label class="pg-size">
        <span>Rows per page</span>
        <select class="pg-select" (change)="setSize(+$any($event.target).value)">
          @for (n of sizes(); track n) {<option [value]="n" [selected]="n === pageSize()">{{ n }}</option>}
        </select>
      </label>
      <span class="pg-range" aria-live="polite">{{ range() }}</span>
      <span class="pg-nav">
        <button type="button" class="pg-btn" [disabled]="page() === 0" (click)="page.set(page() - 1)" aria-label="Previous page"><app-icon name="arrow-left" [size]="16" /></button>
        <button type="button" class="pg-btn" [disabled]="page() >= pages() - 1" (click)="page.set(page() + 1)" aria-label="Next page"><app-icon name="arrow-right" [size]="16" /></button>
      </span>
    </nav>
  `,
  styles: `
    .pager {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: 12px 24px;
      padding: 12px 20px;
      border-top: 1px solid var(--border-soft);
      font-size: 13px;
      color: var(--text-muted);
    }
    .pg-size {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
    }
    .pg-select {
      height: 32px;
      padding: 0 28px 0 10px;
      border: 1px solid var(--border-strong);
      border-radius: var(--r-control);
      background: var(--surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%235b6675' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E") no-repeat right 8px center;
      appearance: none;
      font: inherit;
      color: var(--text);
    }
    .pg-select:focus { outline: none; border-color: var(--mobi-blue); box-shadow: var(--focus-ring); }
    .pg-range { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--text); }
    .pg-nav { display: inline-flex; gap: 4px; }
    .pg-btn {
      width: 32px;
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--border);
      border-radius: var(--r-control);
      background: var(--surface);
      color: var(--text);
      cursor: pointer;
    }
    .pg-btn:hover:not(:disabled) { background: var(--surface-muted); }
    .pg-btn:disabled { color: var(--text-subtle); cursor: not-allowed; opacity: 0.6; }
    .pg-btn:focus-visible { outline: none; box-shadow: var(--focus-ring); }
  `,
})
export class Pager {
  readonly total = input.required<number>();
  readonly page = model(0);
  readonly pageSize = model(25);
  readonly sizes = input([10, 25, 50]);

  protected readonly pages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));
  protected readonly range = computed(() => {
    const t = this.total();
    if (!t) return '0 of 0';
    const from = this.page() * this.pageSize() + 1;
    return `${from}–${Math.min(t, from + this.pageSize() - 1)} of ${t}`;
  });

  protected setSize(n: number) {
    this.pageSize.set(n);
    this.page.set(0);
  }
}
