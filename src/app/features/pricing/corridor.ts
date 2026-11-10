import { ChangeDetectionStrategy, Component, computed, inject, Injectable, signal } from '@angular/core';
import { GlobalFilters } from '../../core/merchants/global-filters.service';
import { countryName } from '../../core/merchants/onboarding-config';
import { CORRIDORS } from '../../core/merchants/products';

const FLAG: Record<string, string> = { MY: '🇲🇾', ID: '🇮🇩', VN: '🇻🇳' };

/**
 * The corridor Merchant Pricing screens are scoped to (§7): the header's country filter when it is
 * a corridor, otherwise the last one chosen here (default Malaysia).
 */
@Injectable({ providedIn: 'root' })
export class CorridorService {
  private readonly filters = inject(GlobalFilters);
  private readonly fallback = signal<string>('MY');
  readonly code = computed(() => ((CORRIDORS as readonly string[]).includes(this.filters.country()) ? this.filters.country() : this.fallback()));
  readonly name = computed(() => countryName(this.code()));
  readonly flag = computed(() => FLAG[this.code()] ?? '');

  set(code: string) {
    this.fallback.set(code);
    this.filters.set('country', code);
  }
}

@Component({
  selector: 'app-corridor-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="corridor">
      <span>Corridor</span>
      <select class="f-input sm" (change)="corridor.set($any($event.target).value)" aria-label="Corridor">
        @for (c of corridors; track c) {
          <option [value]="c" [selected]="c === corridor.code()">{{ flag(c) }} {{ name(c) }}</option>
        }
      </select>
    </label>
  `,
  styles: `
    .corridor { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: var(--text-muted); }
    .corridor select { min-width: 160px; }
  `,
})
export class CorridorSelect {
  protected readonly corridor = inject(CorridorService);
  protected readonly corridors = CORRIDORS;
  protected readonly name = countryName;
  protected readonly flag = (c: string) => FLAG[c] ?? '';
}
