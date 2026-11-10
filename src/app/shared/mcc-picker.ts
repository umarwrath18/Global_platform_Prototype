import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { MccOption } from '../core/merchants/mcc';

/**
 * Searchable MCC list grouped by nature of business, as payment providers present it. The group
 * matching the selected nature of business is listed first. Choosing an option emits its code.
 */
@Component({
  selector: 'app-mcc-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mcc-picker">
      <input
        type="search"
        class="f-input"
        [id]="inputId()"
        placeholder="Search by code or description"
        autocomplete="off"
        [disabled]="disabled()"
        [value]="query()"
        (input)="query.set($any($event.target).value)"
        [attr.aria-describedby]="describedBy()"
        aria-controls="mcc-options"
      />
      <select id="mcc-options" class="f-input list" size="7" [class.invalid]="invalid()" [disabled]="disabled()" [attr.aria-label]="'Merchant category code'" (change)="selected.emit($any($event.target).value)">
        @for (g of groups(); track g.name) {
          <optgroup [label]="g.name">
            @for (o of g.options; track o.code) {
              <option [value]="o.code" [selected]="o.code === value()">{{ o.code }} – {{ o.description }}{{ o.availability === 'restricted' ? ' (restricted)' : '' }}</option>
            }
          </optgroup>
        }
      </select>
      @if (!groups().length) {
        <p class="f-hint" role="status">No MCC matches "{{ query() }}".</p>
      }
    </div>
  `,
  styles: `
    .mcc-picker { display: grid; gap: 6px; }
    .list { height: auto; min-height: 168px; padding: 4px; background-image: none; }
    .list option { padding: 4px 6px; }
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

  protected readonly query = signal('');

  protected readonly groups = computed(() => {
    const q = this.query().trim().toLowerCase();
    const match = (o: MccOption) => !q || o.code.includes(q) || o.description.toLowerCase().includes(q) || o.group.toLowerCase().includes(q) || o.code === this.value();
    const map = new Map<string, MccOption[]>();
    for (const o of this.options().filter(match)) map.set(o.group, [...(map.get(o.group) ?? []), o]);
    const first = this.preferredGroup();
    return [...map.entries()]
      .map(([name, options]) => ({ name, options: options.sort((a, b) => a.code.localeCompare(b.code)) }))
      .sort((a, b) => Number(b.name === first) - Number(a.name === first) || Number(a.name === 'Other') - Number(b.name === 'Other') || a.name.localeCompare(b.name));
  });
}
