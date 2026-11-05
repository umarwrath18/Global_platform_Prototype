import { ChangeDetectionStrategy, Component, input, model, signal } from '@angular/core';
import { Icon } from './icon';

/** Shows recovery codes once, with copy / download, and the "I've saved them" acknowledgement (PRD §8 Q8). */
@Component({
  selector: 'app-recovery-codes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div class="codes" role="group" aria-label="Recovery codes">
      <ol>
        @for (c of codes(); track c) {
          <li><code>{{ c }}</code></li>
        }
      </ol>
      <div class="actions">
        <button type="button" class="act" (click)="copy()"><app-icon [name]="copied() ? 'check' : 'copy'" [size]="14" />{{ copied() ? 'Copied' : 'Copy codes' }}</button>
        <button type="button" class="act" (click)="download()"><app-icon name="download" [size]="14" />Download .txt</button>
      </div>
    </div>
    <ul class="facts">
      <li>Each code works <strong>once</strong>, instead of a code from your authenticator app.</li>
      <li>If you use one, you'll be asked to set up a new authenticator straight away.</li>
      <li>We won't show these codes again. Store them somewhere safe, like a password manager.</li>
    </ul>
    <label class="ack">
      <input type="checkbox" [checked]="acknowledged()" (change)="acknowledged.set($any($event.target).checked)" />
      <span>I've saved these recovery codes somewhere safe</span>
    </label>
  `,
  styles: `
    .codes {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px 16px;
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface-muted);
    }
    ol {
      display: grid;
      gap: 6px;
      margin: 0;
      padding-left: 22px;
      font-size: 13px;
      color: var(--text-muted);
    }
    code {
      font-size: 17px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: var(--text);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .act {
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
      &:hover { border-color: var(--border-strong); }
      &:focus-visible { outline: none; box-shadow: var(--focus-ring); }
    }
    .facts {
      display: grid;
      gap: 6px;
      margin: 14px 0 18px;
      padding-left: 18px;
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-muted);
      strong { color: var(--text); }
    }
    .ack {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin-bottom: 20px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      input {
        width: 18px;
        height: 18px;
        margin: 1px 0 0;
        accent-color: var(--mobi-blue);
        cursor: pointer;
      }
    }
  `,
})
export class RecoveryCodes {
  readonly codes = input.required<string[]>();
  readonly accountLabel = input('');
  readonly acknowledged = model(false);

  protected readonly copied = signal(false);

  private text() {
    return [
      'Mobi Global Platform — 2FA recovery codes',
      this.accountLabel() ? `Account: ${this.accountLabel()}` : '',
      `Generated: ${new Date().toISOString()}`,
      '',
      ...this.codes(),
      '',
      'Each code can be used once. Keep this file somewhere safe.',
    ]
      .filter((l, i) => l || i > 1)
      .join('\n');
  }

  protected async copy() {
    try {
      await navigator.clipboard.writeText(this.codes().join('\n'));
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      // Codes stay visible to copy by hand.
    }
  }

  protected download() {
    const url = URL.createObjectURL(new Blob([this.text()], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mobi-recovery-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
