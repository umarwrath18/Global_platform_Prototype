import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { toClientError } from '../../core/api/api-error';
import { fmtDateTime, fmtMoney, TXN_FLOW_LABEL, TxnDetail, TxnFlow } from '../../core/transactions/transactions';
import { TransactionsApi } from '../../core/transactions/transactions-api.service';
import { Icon } from '../../shared/icon';
import { SideSheet } from '../../shared/side-sheet';
import { PaymentPath, TxnIpn, TxnSections, TxnStatusBadge, TxnTimeline } from '../../shared/txn-ui';

type Tab = 'details' | 'timeline' | 'ipn' | 'notes' | 'audit';

/**
 * Transaction details (internal) in a side sheet: the payment path, then sections in the same order
 * (Customer → Merchant → Mobi → Provider → Bank, and the payment type's own details), with tabs for
 * the timeline, IPN attempts, notes and the audit log. Footer: flag for investigation (or clear the
 * flag with a resolution) and add a note. Requery and refunds come later.
 */
@Component({
  selector: 'app-transaction-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, SideSheet, PaymentPath, TxnSections, TxnStatusBadge, TxnTimeline, TxnIpn],
  template: `
    <app-side-sheet label="Transaction details" (dismiss)="closed.emit()">
      <header class="sheet-head">
        <div class="sheet-titles">
          @if (d(); as t) {
            <p class="sheet-eyebrow">{{ flowLabel[t.flow] }} · {{ t.methodName }}@if (t.paymentTypeLabel !== t.methodName) { · {{ t.paymentTypeLabel }}} · {{ t.countryName }}</p>
            <div class="txn-id-row">
              <span>{{ t.transactionId }}</span>
              <button type="button" class="copy" (click)="copy(t.transactionId)" [attr.aria-label]="copied() ? 'Copied' : 'Copy transaction ID'" [title]="copied() ? 'Copied' : 'Copy transaction ID'"><app-icon [name]="copied() ? 'check' : 'copy'" [size]="14" /></button>
            </div>
            <div class="txn-sheet-amount"><span class="amt">{{ money(t.amount, t.currency) }}</span><app-txn-status [status]="t.status" /></div>
            <p class="sheet-sub">Created {{ when(t.createdAt) }}@if (t.completedAt) { · Completed {{ when(t.completedAt) }}}</p>
          } @else {
            <p class="sheet-eyebrow">{{ flowLabel[flow()] }}</p>
            <div class="txn-id-row">{{ id() }}</div>
          }
        </div>
        <button type="button" class="sheet-close" (click)="closed.emit()" aria-label="Close"><app-icon name="x" [size]="18" /></button>
      </header>

      @if (d(); as t) {
        <nav class="txn-sheet-tabs" role="tablist" aria-label="Transaction">
          <button type="button" role="tab" [class.on]="tab() === 'details'" [attr.aria-selected]="tab() === 'details'" (click)="tab.set('details')">Details</button>
          <button type="button" role="tab" [class.on]="tab() === 'timeline'" [attr.aria-selected]="tab() === 'timeline'" (click)="tab.set('timeline')">Timeline</button>
          <button type="button" role="tab" [class.on]="tab() === 'ipn'" [attr.aria-selected]="tab() === 'ipn'" (click)="tab.set('ipn')">IPN</button>
          <button type="button" role="tab" [class.on]="tab() === 'notes'" [attr.aria-selected]="tab() === 'notes'" (click)="tab.set('notes')">Notes ({{ t.notes.length }})</button>
          <button type="button" role="tab" [class.on]="tab() === 'audit'" [attr.aria-selected]="tab() === 'audit'" (click)="tab.set('audit')">Audit</button>
        </nav>

        <div class="sheet-body">
          @for (f of t.flags; track f.flag) {
            <div class="txn-flag-card" [class.conflict]="f.flag === 'status_conflict'" role="note">
              <strong>{{ f.label }}</strong>
              <span>{{ f.reason }}</span>
              <div class="txn-meta">{{ f.raisedBy }} · {{ when(f.raisedAt) }}@if (f.ticket) { · Ticket {{ f.ticket }}}</div>
            </div>
          }

          @switch (tab()) {
            @case ('details') {
              <app-payment-path [steps]="t.path" [flow]="t.flow" />
              <app-txn-sections [sections]="t.sections" [numbered]="true" [links]="true" [flow]="t.flow" />
            }
            @case ('timeline') {
              <section class="sheet-section"><h3>Status changes</h3><app-txn-timeline [entries]="t.timeline" /></section>
            }
            @case ('ipn') {
              <section class="sheet-section"><h3>Merchant notifications (IPN)</h3><app-txn-ipn [status]="t.ipn.status" [url]="t.ipn.url" [attempts]="t.ipn.attempts" /></section>
            }
            @case ('notes') {
              <section class="sheet-section">
                <h3>Notes</h3>
                @if (t.can.addNote) {
                  <form (submit)="$event.preventDefault(); addNote()">
                    <label class="f-label" for="txn-note">Add a note</label>
                    <textarea id="txn-note" class="f-input" rows="3" maxlength="1000" [value]="noteText()" (input)="noteText.set($any($event.target).value)" placeholder="What happened, who you spoke to, what's next"></textarea>
                    @if (noteError(); as e) {<p class="f-error" role="alert"><app-icon name="alert-circle" [size]="14" />{{ e }}</p>}
                    <p class="f-hint">Notes can't be edited or deleted. To correct one, add a new note.</p>
                    <div class="actions" style="margin-top: 8px"><button type="submit" class="btn primary" [disabled]="busy()">Add note</button></div>
                  </form>
                }
                @if (t.notes.length) {
                  <ul class="txn-notes">
                    @for (n of t.notes; track n.id) {
                      <li><div class="txn-meta">{{ n.by }} · {{ n.team }} · {{ when(n.at) }}</div><p class="note-text">{{ n.text }}</p></li>
                    }
                  </ul>
                } @else {
                  <p class="txn-meta">No notes yet.</p>
                }
              </section>
            }
            @case ('audit') {
              <section class="sheet-section">
                <h3>Audit log</h3>
                @if (t.audit.length) {
                  <ol class="txn-timeline">
                    @for (a of t.audit; track a.id) {
                      <li><strong>{{ a.action }}</strong><div class="txn-meta">{{ a.actor }} · {{ a.team }} · {{ when(a.at) }}</div>@if (a.detail) {<div class="txn-meta">{{ a.detail }}</div>}</li>
                    }
                  </ol>
                } @else {
                  <p class="txn-meta">Nothing recorded yet.</p>
                }
              </section>
            }
          }
        </div>

        @if (mode() === 'flag') {
          <form class="sheet-confirm" (submit)="$event.preventDefault(); raiseFlag()">
            <h3>Flag for investigation</h3>
            <p>Others see the flag in the list and here. It doesn't change the transaction.</p>
            <div>
              <label class="f-label" for="flag-reason">Reason <span class="req">*</span></label>
              <textarea id="flag-reason" class="f-input" rows="2" maxlength="500" [value]="reason()" (input)="reason.set($any($event.target).value)" autofocus></textarea>
            </div>
            <div>
              <label class="f-label" for="flag-ticket">Ticket reference (optional)</label>
              <input id="flag-ticket" class="f-input" maxlength="60" [value]="ticket()" (input)="ticket.set($any($event.target).value)" placeholder="e.g. OPS-1234" />
            </div>
            @if (formError(); as e) {<p class="f-error" role="alert"><app-icon name="alert-circle" [size]="14" />{{ e }}</p>}
            <div class="sheet-confirm-actions">
              <button type="button" class="btn" (click)="cancelMode()">Cancel</button>
              <button type="submit" class="btn primary" [disabled]="busy()">Flag</button>
            </div>
          </form>
        } @else if (mode() === 'clear') {
          <form class="sheet-confirm" (submit)="$event.preventDefault(); clearFlag()">
            <h3>Clear the investigation flag</h3>
            <p>Say what you found. The resolution is kept in the audit log.</p>
            <div>
              <label class="f-label" for="flag-resolution">Resolution note <span class="req">*</span></label>
              <textarea id="flag-resolution" class="f-input" rows="2" maxlength="500" [value]="reason()" (input)="reason.set($any($event.target).value)" autofocus></textarea>
            </div>
            @if (formError(); as e) {<p class="f-error" role="alert"><app-icon name="alert-circle" [size]="14" />{{ e }}</p>}
            <div class="sheet-confirm-actions">
              <button type="button" class="btn" (click)="cancelMode()">Cancel</button>
              <button type="submit" class="btn primary" [disabled]="busy()">Clear flag</button>
            </div>
          </form>
        } @else if (t.can.flag || t.can.addNote) {
          <footer class="sheet-foot">
            <span class="sheet-foot-note">Requery and refunds come in a later phase.</span>
            @if (t.can.flag) {
              @if (flagged()) {
                <button type="button" class="btn" (click)="startMode('clear')">Clear flag</button>
              } @else {
                <button type="button" class="btn" (click)="startMode('flag')">Flag for investigation</button>
              }
            }
            @if (t.can.addNote) {<button type="button" class="btn" (click)="tab.set('notes')">Add note</button>}
          </footer>
        }
      } @else if (error(); as e) {
        <div class="sheet-body"><div class="empty-state" role="alert"><div class="icon-tile"><app-icon name="alert-circle" /></div><h3>We couldn't load this transaction</h3><p>{{ e }}</p></div></div>
      } @else {
        <div class="sheet-body"><div class="skeleton-rows" aria-busy="true" aria-label="Loading transaction"><span></span><span></span><span></span></div></div>
      }
    </app-side-sheet>
  `,
})
export class TransactionSheet {
  private readonly api = inject(TransactionsApi);

  readonly flow = input.required<TxnFlow>();
  readonly id = input.required<string>();
  readonly closed = output<void>();
  /** A note or flag was saved (message for the page's toast). */
  readonly changed = output<string>();

  protected readonly d = signal<TxnDetail | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly tab = signal<Tab>('details');
  protected readonly mode = signal<'flag' | 'clear' | null>(null);
  protected readonly reason = signal('');
  protected readonly ticket = signal('');
  protected readonly formError = signal<string | null>(null);
  protected readonly noteText = signal('');
  protected readonly noteError = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly copied = signal(false);

  protected readonly flowLabel = TXN_FLOW_LABEL;
  protected readonly money = fmtMoney;
  protected readonly when = (t: number) => fmtDateTime(t);

  constructor() {
    effect(() => {
      const flow = this.flow();
      const id = this.id();
      untracked(() => {
        this.d.set(null);
        this.tab.set('details');
        void this.load(flow, id);
      });
    });
  }

  protected flagged() {
    return !!this.d()?.flags.some((f) => f.flag === 'investigation');
  }

  private async load(flow = this.flow(), id = this.id()) {
    this.error.set(null);
    try {
      this.d.set(await this.api.detail(flow, id));
    } catch (e) {
      const err = toClientError(e);
      this.error.set(err.code === 'NOT_FOUND' ? 'It may be in another flow, or in a country you can’t access.' : 'message' in err && typeof err.message === 'string' ? err.message : 'Please try again in a moment.');
    }
  }

  protected startMode(m: 'flag' | 'clear') {
    this.reason.set('');
    this.ticket.set('');
    this.formError.set(null);
    this.mode.set(m);
  }

  protected cancelMode() {
    this.mode.set(null);
  }

  protected async addNote() {
    const text = this.noteText().trim();
    if (!text) {
      this.noteError.set('Enter a note.');
      return;
    }
    await this.run(() => this.api.addNote(this.flow(), this.id(), text), 'Note added.', (msg) => this.noteError.set(msg));
    if (!this.noteError()) this.noteText.set('');
  }

  protected async raiseFlag() {
    if (!this.reason().trim()) {
      this.formError.set('Enter a reason for the investigation.');
      return;
    }
    await this.run(() => this.api.flag(this.flow(), this.id(), this.reason().trim(), this.ticket().trim()), 'Flagged for investigation.', (msg) => this.formError.set(msg));
  }

  protected async clearFlag() {
    if (!this.reason().trim()) {
      this.formError.set('Enter a resolution note.');
      return;
    }
    await this.run(() => this.api.clearFlag(this.flow(), this.id(), this.reason().trim()), 'Investigation flag cleared.', (msg) => this.formError.set(msg));
  }

  private async run(action: () => Promise<unknown>, done: string, onError: (msg: string) => void) {
    if (this.busy()) return;
    this.busy.set(true);
    this.noteError.set(null);
    this.formError.set(null);
    try {
      await action();
      this.mode.set(null);
      await this.load();
      this.changed.emit(done);
    } catch (e) {
      const err = toClientError(e);
      onError('message' in err && typeof err.message === 'string' ? err.message : 'That didn’t work. Please try again.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      // Clipboard not available (e.g. insecure context); the ID is on screen to copy by hand.
    }
  }
}
