import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { Icon } from './icon';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-12" → "12 Nov 2026" (the app's one date format). */
export function displayDate(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
}

/**
 * Date field that always shows "12 Nov 2026", whatever the browser's locale. The real control is
 * the browser's own date input (keyboard, screen readers and the native calendar all work); it sits
 * transparently over the formatted text.
 */
@Component({
  selector: 'app-date-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <span class="df" [class.disabled]="disabled()" [class.invalid]="invalid()">
      <span class="df-text" [class.placeholder]="!text()" aria-hidden="true">{{ text() || 'Select date' }}</span>
      <app-icon name="calendar" [size]="16" class="df-icon" />
      <input
        type="date"
        [id]="inputId()"
        [value]="value() ?? ''"
        [min]="min() ?? ''"
        [max]="max() ?? ''"
        [disabled]="disabled()"
        [attr.aria-label]="ariaLabel()"
        [attr.aria-invalid]="invalid() || null"
        (input)="changed.emit($any($event.target).value)"
        (click)="open($any($event.target))"
      />
    </span>
  `,
  styles: `
    :host { display: block; }
    .df {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      height: var(--h-control);
      padding: 0 12px;
      border: 1px solid var(--border-strong);
      border-radius: var(--r-control);
      background: var(--surface);
      font-size: 14px;
    }
    .df:focus-within { border-color: var(--mobi-blue); box-shadow: var(--focus-ring); }
    .df.invalid { border-color: var(--danger); }
    .df.disabled { background: var(--surface-muted); color: var(--text-subtle); }
    .df-text.placeholder { color: var(--text-subtle); }
    .df-icon { color: var(--text-muted); }
    input {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      cursor: pointer;
      border: 0;
      padding: 0;
    }
    input:disabled { cursor: not-allowed; }
  `,
})
export class DateField {
  readonly value = input<string | null>(null);
  readonly min = input<string | null>(null);
  readonly max = input<string | null>(null);
  readonly disabled = input(false);
  readonly invalid = input(false);
  readonly inputId = input<string | null>(null);
  readonly ariaLabel = input<string | null>(null);
  readonly changed = output<string>();

  protected readonly text = computed(() => displayDate(this.value()));

  protected open(el: HTMLInputElement & { showPicker?: () => void }) {
    try {
      el.showPicker?.();
    } catch {
      // Some browsers only allow it from certain gestures; the native control still works.
    }
  }
}
