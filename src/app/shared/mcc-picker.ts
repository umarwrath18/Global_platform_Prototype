import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MccOption } from '../core/merchants/mcc';

/**
 * MCC dropdown grouped by nature of business, as payment providers present it. The group matching
 * the selected nature of business is listed first. Choosing an option emits its code.
 */
@Component({
  selector: 'app-mcc-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <select [id]="inputId()" class="f-input" [class.invalid]="invalid()" [disabled]="disabled()" [attr.aria-describedby]="describedBy()" (change)="selected.emit($any($event.target).value)">
      <option value="" [selected]="!value()" disabled>Select MCC</option>
      @for (g of groups(); track g.name) {
        <optgroup [label]="g.name">
          @for (o of g.options; track o.code) {
            <option [value]="o.code" [selected]="o.code === value()">{{ o.code }} – {{ o.description }}{{ o.availability === 'restricted' ? ' (restricted)' : '' }}</option>
          }
        </optgroup>
      }
    </select>
  `,
})
export class MccPicker {
  readonly inputId = input.required<string>();
  readonly options = input.required<MccOption[]>();
  readonly value = input<string | null>(null);
  /** Nature of business: its group is listed first. */
  readonly preferredGroup = input<string>('');
  readonly disabled = input(false);
  readonly invalid = input(false);
  readonly describedBy = input<string | null>(null);
  readonly selected = output<string>();

  protected readonly groups = computed(() => {
    const map = new Map<string, MccOption[]>();
    for (const o of this.options()) map.set(o.group, [...(map.get(o.group) ?? []), o]);
    const first = this.preferredGroup();
    return [...map.entries()]
      .map(([name, options]) => ({ name, options: options.sort((a, b) => a.code.localeCompare(b.code)) }))
      .sort((a, b) => Number(b.name === first) - Number(a.name === first) || Number(a.name === 'Other') - Number(b.name === 'Other') || a.name.localeCompare(b.name));
  });
}
