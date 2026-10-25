import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { AuthService } from '../../core/auth/auth.service';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import { ApplicationStatus, ChecklistItem, CountryApplication, ReadinessAction, ReadinessStage } from '../../core/merchants/merchant-models';
import { ONBOARDING_COUNTRIES } from '../../core/merchants/onboarding-config';
import { Icon } from '../../shared/icon';
import { fmtDateTime } from '../../shared/merchant-ui';

interface StageView {
  key: 'configuration' | 'keys' | 'integration' | 'go_live';
  title: string;
  description: string;
  state: 'done' | 'current' | 'upcoming';
  checklist: ReadinessStage | null;
}

const ORDER: ApplicationStatus[] = ['risk_approved', 'cs_configuration', 'keys_generated', 'integration', 'go_live_verification', 'operational'];

/** CS operational readiness after Risk approval. All downstream steps are simulated in this batch. */
@Component({
  selector: 'app-readiness-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './readiness-panel.html',
  styleUrl: './panels.scss',
})
export class ReadinessPanel {
  private readonly api = inject(MerchantApi);
  private readonly auth = inject(AuthService);

  readonly application = input.required<CountryApplication>();
  readonly canAct = input(false);
  readonly changed = output<{ application: CountryApplication; message?: string }>();

  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly dateTime = fmtDateTime;

  protected readonly cfg = computed(() => ONBOARDING_COUNTRIES[this.application().country]);
  protected readonly pricing = computed(() =>
    this.cfg()
      .paymentMethods.map((m) => ({ m, line: this.application().data.pricing.find((p) => p.code === m.code) }))
      .filter((x) => x.line?.enabled),
  );

  protected readonly stages = computed<StageView[]>(() => {
    const i = ORDER.indexOf(this.application().status);
    const state = (start: number, end: number): StageView['state'] => (i >= end ? 'done' : i >= start ? 'current' : 'upcoming');
    return [
      { key: 'configuration', title: 'CS configuration', description: 'Configure the country, settlement, payment methods and pricing.', state: state(0, 2), checklist: 'configuration' },
      { key: 'keys', title: 'Production keys', description: 'Generated only after Risk approval and completed configuration.', state: i >= 2 ? 'done' : 'upcoming', checklist: null },
      { key: 'integration', title: 'Merchant integration', description: 'The merchant integrates using the production keys.', state: state(2, 4), checklist: 'integration' },
      { key: 'go_live', title: 'Go-live verification', description: 'Must pass before the country becomes operational.', state: state(4, 5), checklist: 'go_live' },
    ];
  });

  protected items(stage: ReadinessStage): ChecklistItem[] {
    return this.application().readiness[stage];
  }

  protected allDone(stage: ReadinessStage) {
    return this.items(stage).every((i) => i.done);
  }

  protected checklistOpen(stage: ReadinessStage) {
    const s = this.application().status;
    return this.canAct() && ((stage === 'configuration' && s === 'cs_configuration') || (stage === 'integration' && s === 'integration') || (stage === 'go_live' && s === 'go_live_verification'));
  }

  protected toggle(stage: ReadinessStage, item: ChecklistItem, done: boolean) {
    void this.run({ action: 'set_item', stage, key: item.key, done }, `${stage}:${item.key}`);
  }

  protected async run(action: ReadinessAction, busyKey: string = action.action, message?: string) {
    this.busy.set(busyKey);
    this.error.set(null);
    try {
      const app = await this.api.readiness(this.application().id, action);
      if (action.action === 'confirm_go_live') void this.auth.refresh();
      this.changed.emit({ application: app, message });
    } catch (e) {
      this.error.set(toMerchantError(e).message ?? 'We could not update readiness. Please try again.');
    } finally {
      this.busy.set(null);
    }
  }
}
