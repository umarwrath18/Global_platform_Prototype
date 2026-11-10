import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DIAL_CODES } from '../core/merchants/onboarding-config';

/** Splits "+60 12 345 6789" into its dial code and the rest. Unknown codes keep the default. */
export function splitPhone(value: string, defaultCode: string): { code: string; number: string } {
  const v = value.trim();
  const code = [...DIAL_CODES].sort((a, b) => b.length - a.length).find((c) => v.startsWith(c));
  return code ? { code, number: v.slice(code.length).trim() } : { code: defaultCode, number: v };
}

/** Phone number with a country code preset (changeable). Emits the full number, or '' when empty. */
@Component({
  selector: 'app-phone-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="phone" [class.invalid]="invalid()">
      <select class="f-input code" [attr.aria-label]="label() + ' country code'" (change)="emit($any($event.target).value, parts().number)">
        @for (c of codes(); track c) {
          <option [value]="c" [selected]="c === parts().code">{{ c }}</option>
        }
      </select>
      <input
        [id]="inputId()"
        class="f-input"
        type="tel"
        inputmode="tel"
        autocomplete="tel-national"
        [class.invalid]="invalid()"
        [value]="parts().number"
        [attr.aria-describedby]="describedBy()"
        (input)="emit(parts().code, $any($event.target).value)"
        (blur)="blurred.emit()"
      />
    </div>
  `,
  styles: `
    .phone { display: grid; grid-template-columns: 96px 1fr; gap: 8px; }
    .code { padding-right: 8px; }
  `,
})
export class PhoneField {
  readonly inputId = input.required<string>();
  readonly value = input('');
  readonly defaultCode = input('+60');
  readonly label = input('Phone number');
  readonly invalid = input(false);
  readonly describedBy = input<string | null>(null);
  readonly valueChange = output<string>();
  readonly blurred = output<void>();

  protected readonly parts = computed(() => splitPhone(this.value(), this.defaultCode()));
  protected readonly codes = computed(() => (DIAL_CODES.includes(this.defaultCode()) ? DIAL_CODES : [this.defaultCode(), ...DIAL_CODES]));

  protected emit(code: string, number: string) {
    const n = number.trim();
    this.valueChange.emit(n ? `${code} ${n}` : '');
  }
}
