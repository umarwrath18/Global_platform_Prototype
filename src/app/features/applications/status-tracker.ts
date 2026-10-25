import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ApplicationStatus } from '../../core/merchants/merchant-models';

type StepState = 'done' | 'current' | 'upcoming' | 'warning' | 'danger';
interface Step {
  label: string;
  state: StepState;
}

const READINESS: { status: ApplicationStatus; label: string }[] = [
  { status: 'cs_configuration', label: 'CS configuration' },
  { status: 'keys_generated', label: 'Production keys' },
  { status: 'integration', label: 'Merchant integration' },
  { status: 'go_live_verification', label: 'Go-live verification' },
  { status: 'operational', label: 'Operational' },
];

/** Two lanes: application review (Risk decides) and operational readiness (CS completes). */
@Component({
  selector: 'app-status-tracker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lanes">
      <div class="lane">
        <p class="lane-label">Application review</p>
        <ol>
          @for (s of review(); track $index) {
            <li [class]="s.state" [attr.aria-current]="s.state === 'current' || s.state === 'warning' ? 'step' : null">
              <span class="dot" aria-hidden="true"></span><span class="lbl">{{ s.label }}</span>
            </li>
          }
        </ol>
      </div>
      <div class="lane">
        <p class="lane-label">Operational readiness</p>
        <ol>
          @for (s of readiness(); track $index) {
            <li [class]="s.state" [attr.aria-current]="s.state === 'current' ? 'step' : null">
              <span class="dot" aria-hidden="true"></span><span class="lbl">{{ s.label }}</span>
            </li>
          }
        </ol>
      </div>
    </div>
  `,
  styles: `
    .lanes {
      display: grid;
      grid-template-columns: minmax(0, 3fr) minmax(0, 5fr);
      gap: 24px;
      padding: 18px 22px;
    }
    .lane-label {
      margin: 0 0 10px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--text-muted);
    }
    ol {
      display: flex;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      position: relative;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 13px;
      color: var(--text-subtle);
    }
    li::after {
      content: '';
      position: absolute;
      top: 6px;
      left: 16px;
      right: 4px;
      height: 2px;
      background: var(--border);
    }
    li:last-child::after {
      display: none;
    }
    .dot {
      position: relative;
      z-index: 1;
      width: 14px;
      height: 14px;
      border: 2px solid var(--border-strong);
      border-radius: 50%;
      background: var(--surface);
    }
    .lbl {
      padding-right: 8px;
      line-height: 1.3;
    }
    .done {
      color: var(--text-muted);
    }
    .done .dot {
      border-color: var(--success);
      background: var(--success);
    }
    .done::after {
      background: var(--success);
    }
    .current {
      color: var(--mobi-blue);
      font-weight: 700;
    }
    .current .dot {
      border-color: var(--mobi-blue);
      box-shadow: 0 0 0 4px rgba(0, 92, 172, 0.15);
    }
    .warning {
      color: var(--warning);
      font-weight: 700;
    }
    .warning .dot {
      border-color: var(--warning);
      background: var(--warning-bg);
    }
    .danger {
      color: var(--danger);
      font-weight: 700;
    }
    .danger .dot {
      border-color: var(--danger);
      background: var(--danger);
    }
    @media (max-width: 900px) {
      .lanes {
        grid-template-columns: minmax(0, 1fr);
      }
      ol {
        flex-direction: column;
        gap: 8px;
      }
      li {
        flex-direction: row;
        align-items: center;
      }
      li::after {
        display: none;
      }
    }
  `,
})
export class StatusTracker {
  readonly status = input.required<ApplicationStatus>();

  protected readonly review = computed<Step[]>(() => {
    const s = this.status();
    const decided = !['draft', 'pending_risk_review', 'returned'].includes(s);
    const decision: Step =
      s === 'rejected'
        ? { label: 'Rejected', state: 'danger' }
        : s === 'returned'
          ? { label: 'Returned for correction', state: 'warning' }
          : { label: 'Risk approved', state: decided ? 'done' : 'upcoming' };
    return [
      { label: 'Draft', state: s === 'draft' ? 'current' : 'done' },
      { label: 'Pending Risk review', state: s === 'pending_risk_review' ? 'current' : s === 'draft' || s === 'returned' ? 'upcoming' : 'done' },
      decision,
    ];
  });

  protected readonly readiness = computed<Step[]>(() => {
    const s = this.status();
    const idx = READINESS.findIndex((r) => r.status === s);
    const approved = s === 'risk_approved';
    return READINESS.map((r, i) => ({
      label: r.label,
      state: s === 'rejected' ? 'upcoming' : approved ? (i === 0 ? 'current' : 'upcoming') : idx < 0 ? 'upcoming' : i < idx || s === 'operational' ? 'done' : i === idx ? 'current' : 'upcoming',
    }));
  });
}
