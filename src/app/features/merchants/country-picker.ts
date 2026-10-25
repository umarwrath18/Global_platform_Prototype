import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { ApplicationStatus, GlobalMerchant } from '../../core/merchants/merchant-models';
import { ONBOARDING_COUNTRIES } from '../../core/merchants/onboarding-config';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { Icon } from '../../shared/icon';
import { StatusBadge } from '../../shared/merchant-ui';

interface CountryOption {
  code: string;
  name: string;
  currency: string;
  documents: number;
  methods: number;
  directors: boolean;
  open: { id: string; status: ApplicationStatus } | null;
  rejected: string | null;
}

/** Choose a country and open a new Country Application for an existing Global Merchant. */
@Component({
  selector: 'app-country-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, StatusBadge],
  template: `
    <fieldset class="countries">
      <legend class="sr-only">Onboarding country</legend>
      @for (c of options(); track c.code) {
        <label class="c-card" [class.disabled]="!!c.open" [class.selected]="selected() === c.code">
          <input type="radio" name="country" [value]="c.code" [disabled]="!!c.open" [checked]="selected() === c.code" (change)="selected.set(c.code)" />
          <span class="c-top">
            <span class="cc">{{ c.code }}</span>
            <span class="c-name">{{ c.name }}</span>
            <span class="tag">{{ c.currency }}</span>
          </span>
          @if (c.open; as o) {
            <span class="c-note">Open application <a [routerLink]="['/applications', o.id]">{{ o.id }}</a></span>
            <app-status [status]="o.status" />
          } @else {
            <span class="c-note">{{ c.documents }} documents · {{ c.methods }} payment methods{{ c.directors ? ' · directors' : '' }}</span>
            @if (c.rejected) {
              <span class="c-note warn">{{ c.rejected }} was rejected. This starts a new application.</span>
            }
          }
        </label>
      }
    </fieldset>
    @if (error(); as e) {
      <div class="alert danger compact" role="alert">
        <app-icon name="alert-circle" />
        <div>{{ e.message ?? 'We couldn't create the application. Please try again.' }}</div>
      </div>
    }
    <div class="picker-foot">
      <button type="button" class="btn primary" [disabled]="!selected() || busy() || roles.role() !== 'sales'" (click)="create()">
        @if (busy()) {
          <span class="spinner" aria-hidden="true"></span>Creating…
        } @else {
          {{ selected() ? 'Start ' + selectedName() + ' application' : 'Choose a country' }}<app-icon name="arrow-right" [size]="16" />
        }
      </button>
    </div>
  `,
  styles: `
    .countries {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
      gap: 10px;
      margin: 0;
      padding: 0;
      border: 0;
    }
    .c-card {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: var(--r-control);
      background: var(--surface);
      cursor: pointer;
    }
    .c-card:hover:not(.disabled) {
      border-color: var(--border-strong);
    }
    .c-card.selected {
      border-color: var(--mobi-blue);
      background: var(--mobi-blue-tint);
    }
    .c-card.disabled {
      background: var(--surface-page);
      cursor: default;
    }
    .c-card:focus-within {
      border-color: var(--mobi-blue);
    }
    input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }
    .c-top {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
    }
    .cc {
      display: inline-grid;
      place-items: center;
      width: 34px;
      height: 24px;
      border-radius: 5px;
      background: var(--surface-muted);
      font-size: 12px;
      font-weight: 800;
      color: var(--text-muted);
    }
    .c-name {
      flex: 1;
      font-weight: 600;
    }
    .c-note {
      font-size: 12px;
      color: var(--text-muted);
    }
    .c-note.warn {
      color: var(--warning);
    }
    .picker-foot {
      display: flex;
      justify-content: flex-end;
      margin-top: 16px;
    }
  `,
})
export class CountryPicker {
  private readonly api = inject(MerchantApi);
  protected readonly roles = inject(StaffRoleService);

  readonly merchant = input.required<GlobalMerchant>();
  readonly applications = input.required<{ id: string; country: string; status: ApplicationStatus; createdAt: number }[]>();
  readonly opened = output<string>();

  protected readonly selected = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<MerchantClientError | null>(null);

  protected readonly options = computed<CountryOption[]>(() =>
    Object.values(ONBOARDING_COUNTRIES).map((c) => {
      const apps = this.applications().filter((a) => a.country === c.code);
      const open = apps.find((a) => a.status !== 'rejected');
      const rejected = apps.filter((a) => a.status === 'rejected').sort((a, b) => b.createdAt - a.createdAt)[0];
      return {
        code: c.code,
        name: c.name,
        currency: c.currency,
        documents: c.documents.filter((d) => d.required).length,
        methods: c.paymentMethods.length,
        directors: c.directors.required,
        open: open ? { id: open.id, status: open.status } : null,
        rejected: rejected?.id ?? null,
      };
    }),
  );

  protected readonly selectedName = computed(() => ONBOARDING_COUNTRIES[this.selected()]?.name ?? 'country');

  protected async create() {
    this.busy.set(true);
    this.error.set(null);
    try {
      const app = await this.api.createApplication(this.merchant().id, this.selected());
      this.opened.emit(app.id);
    } catch (e) {
      this.error.set(toMerchantError(e));
    } finally {
      this.busy.set(false);
    }
  }
}
