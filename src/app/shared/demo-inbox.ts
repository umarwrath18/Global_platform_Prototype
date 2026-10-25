import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DemoInboxService, InboxMessage } from './demo-inbox.service';
import { Icon } from './icon';

/** Shows prototype emails (OTP codes) on screen in place of a real mailbox. */
@Component({
  selector: 'app-demo-inbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <section class="stack" aria-live="polite" aria-label="Demo inbox">
      @for (m of inbox.messages(); track m.id) {
        <article class="toast">
          <header>
            <span class="badge">Demo inbox</span>
            <span class="to">To: {{ m.to }}</span>
            <button type="button" class="close" (click)="inbox.dismiss(m.id)" aria-label="Dismiss email">
              <app-icon name="x" [size]="16" />
            </button>
          </header>
          <p class="subject">{{ m.subject }}</p>
          <p class="body">Your one-time code is</p>
          <div class="code-row">
            <span class="code">{{ m.code }}</span>
            <button type="button" class="copy" (click)="copy(m)">
              <app-icon [name]="copiedId() === m.id ? 'check' : 'copy'" [size]="16" />
              {{ copiedId() === m.id ? 'Copied' : 'Copy' }}
            </button>
          </div>
          <p class="note">Expires in {{ m.expiresInMin }} minutes. Never share this code. Mobi will never ask for it.</p>
        </article>
      }
    </section>
  `,
  styles: `
    .stack {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 50;
      display: flex;
      flex-direction: column;
      gap: 12px;
      width: min(360px, calc(100vw - 32px));
    }
    @media (max-width: 600px) {
      .stack { right: 16px; top: 16px; }
    }
    .toast {
      padding: 16px 18px;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--surface);
      box-shadow: var(--shadow-pop);
      animation: slide-in 0.25s ease-out;
    }
    @keyframes slide-in {
      from { opacity: 0; transform: translateY(-8px); }
    }
    header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--text-subtle);
    }
    .badge {
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--warning-bg);
      border: 1px solid var(--warning-border);
      color: var(--warning);
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 10px;
    }
    .to {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .close {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border: 0;
      border-radius: 6px;
      background: none;
      color: var(--text-muted);
      cursor: pointer;
      &:hover { background: var(--surface-muted); }
    }
    .subject {
      margin: 10px 0 2px;
      font-weight: 700;
      font-size: 15px;
    }
    .body {
      margin: 0;
      font-size: 14px;
      color: var(--text-muted);
    }
    .code-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 8px 0;
    }
    .code {
      font-size: 30px;
      font-weight: 700;
      letter-spacing: 0.22em;
      color: var(--mobi-blue);
      font-variant-numeric: tabular-nums;
    }
    .copy {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 34px;
      padding: 0 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      &:hover { background: var(--surface-muted); }
    }
    .note {
      margin: 0;
      font-size: 12px;
      color: var(--text-subtle);
    }
  `,
})
export class DemoInbox {
  protected readonly inbox = inject(DemoInboxService);
  protected readonly copiedId = signal<number | null>(null);

  protected async copy(m: InboxMessage) {
    try {
      await navigator.clipboard.writeText(m.code);
      this.copiedId.set(m.id);
      setTimeout(() => this.copiedId.set(null), 1500);
    } catch {
      // Clipboard may be blocked; the code is still visible to copy manually.
    }
  }
}
