import { ChangeDetectionStrategy, Component, effect, input, signal } from '@angular/core';
import { toDataURL } from 'qrcode';
import { AuthenticatorEnrolment } from '../core/api/models';
import { Icon } from './icon';

/** QR code and manual setup key for registering an authenticator app (FR-02). */
@Component({
  selector: 'app-authenticator-qr',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div class="setup">
      <div class="qr-box">
        @if (qr(); as src) {
          <img [src]="src" width="176" height="176" alt="QR code to add your Mobi account to an authenticator app" />
        } @else {
          <span class="qr-loading" aria-hidden="true"></span>
        }
      </div>
    </div>

    <div class="key">
      <div class="key-head">
        <span class="key-label">Setup key</span>
        <span class="key-meta">{{ enrolment().accountLabel }}</span>
      </div>
      <div class="key-row">
        <code>{{ grouped() }}</code>
        <button type="button" class="copy" (click)="copyKey()">
          <app-icon [name]="copied() ? 'check' : 'copy'" [size]="14" />{{ copied() ? 'Copied' : 'Copy key' }}
        </button>
      </div>
    </div>
  `,
  styles: `
    .setup {
      display: flex;
      justify-content: center;
      margin-bottom: 16px;
    }
    .qr-box {
      display: grid;
      place-items: center;
      width: 192px;
      height: 192px;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: #fff;
    }
    .qr-loading {
      width: 176px;
      height: 176px;
      border-radius: 8px;
      background: var(--surface-muted);
    }
    .key {
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface-muted);
    }
    .key-head {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 4px 12px;
      margin-bottom: 6px;
      font-size: 12px;
    }
    .key-label { font-weight: 700; }
    .key-meta { color: var(--text-muted); }
    .key-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    code {
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.06em;
      overflow-wrap: anywhere;
    }
    .copy {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 32px;
      padding: 0 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      &:hover { background: var(--surface-muted); }
    }
  `,
})
export class AuthenticatorQr {
  readonly enrolment = input.required<AuthenticatorEnrolment>();

  protected readonly qr = signal<string | null>(null);
  protected readonly copied = signal(false);

  constructor() {
    effect(() => {
      const uri = this.enrolment().otpauthUri;
      this.qr.set(null);
      toDataURL(uri, { width: 176, margin: 0, errorCorrectionLevel: 'M' })
        .then((src) => this.qr.set(src))
        .catch(() => this.qr.set(null));
    });
  }

  protected grouped() {
    return this.enrolment().secret.replace(/(.{4})/g, '$1 ').trim();
  }

  protected async copyKey() {
    try {
      await navigator.clipboard.writeText(this.enrolment().secret);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      // The key is visible to type by hand.
    }
  }
}
