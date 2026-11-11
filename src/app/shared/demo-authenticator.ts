import { ChangeDetectionStrategy, Component, DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { AuthService } from '../core/auth/auth.service';
import { MockBackend } from '../core/mock-server/mock-backend';
import { Icon } from './icon';

type Source = { kind: 'replace'; token: string } | null;

/**
 * PROTOTYPE ONLY. Tells the Demo authenticator card which pending authenticator to show
 * when a screen is registering a new one while signed in (authenticator replacement).
 */
@Injectable({ providedIn: 'root' })
export class DemoAuthenticatorService {
  readonly replacement = signal<Source>(null);
  /** Set by signed-in screens that ask for a code (Account security, User security). */
  readonly sessionWanted = signal(false);
}

interface Reading {
  code: string;
  secondsLeft: number;
  label: string;
  isNew: boolean;
}

/**
 * PROTOTYPE ONLY. Stands in for a phone's authenticator app so 2FA can be tested without one.
 * It shows the live code for whichever authenticator the current screen is waiting for.
 * Real apps (Google / Microsoft Authenticator) also work by scanning the QR code.
 */
@Component({
  selector: 'app-demo-authenticator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    @if (reading(); as r) {
      <!-- Before sign-in it sits over the decorative brand panel (left); in the portal, bottom-right. -->
      <aside class="card" [class.min]="minimised()" [class.left]="!signedIn()" aria-label="Demo authenticator (prototype)">
        <header>
          <span class="badge">Prototype</span>
          <span class="title">Demo authenticator</span>
          <button type="button" class="icon" (click)="minimised.set(!minimised())" [attr.aria-label]="minimised() ? 'Expand demo authenticator' : 'Minimise demo authenticator'" [attr.aria-expanded]="!minimised()">
            <app-icon [name]="minimised() ? 'chevron-up' : 'chevron-down'" [size]="16" />
          </button>
        </header>
        @if (!minimised()) {
          <p class="acct">Mobi Global Platform · {{ r.label }}{{ r.isNew ? ' (new authenticator)' : '' }}</p>
          <div class="row">
            <span class="code" aria-live="off">{{ r.code.slice(0, 3) }} {{ r.code.slice(3) }}</span>
            <button type="button" class="copy" (click)="copy(r.code)">
              <app-icon [name]="copied() ? 'check' : 'copy'" [size]="14" />{{ copied() ? 'Copied' : 'Copy' }}
            </button>
          </div>
          <div class="timer" role="progressbar" aria-label="Seconds until the code changes" [attr.aria-valuenow]="r.secondsLeft" aria-valuemin="0" aria-valuemax="30">
            <i [style.width.%]="(r.secondsLeft / 30) * 100"></i>
          </div>
          <p class="note">Changes every 30 s. Stands in for your phone's authenticator app in this prototype.</p>
        }
      </aside>
    }
  `,
  styles: `
    .card {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 70; /* above side sheets */
      width: min(300px, calc(100vw - 32px));
      padding: 12px 14px;
      border: 1.5px dashed #d63384;
      border-radius: var(--radius-lg);
      background: var(--surface);
      box-shadow: var(--shadow-pop);
    }
    header {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .badge {
      padding: 1px 7px;
      border-radius: 999px;
      background: #fdf2f8;
      color: #a61e6b;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .title {
      flex: 1;
      font-size: 13px;
      font-weight: 700;
    }
    .icon {
      display: grid;
      place-items: center;
      width: 26px;
      height: 26px;
      border: 0;
      border-radius: 6px;
      background: none;
      color: var(--text-muted);
      cursor: pointer;
      &:hover { background: var(--surface-muted); }
    }
    .acct {
      margin: 8px 0 2px;
      font-size: 12px;
      color: var(--text-muted);
      overflow-wrap: anywhere;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .code {
      font-size: 28px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: var(--mobi-blue);
      font-variant-numeric: tabular-nums;
    }
    .copy {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 30px;
      padding: 0 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      &:hover { background: var(--surface-muted); }
    }
    .timer {
      height: 4px;
      margin: 8px 0;
      overflow: hidden;
      border-radius: 2px;
      background: var(--surface-muted);
      i {
        display: block;
        height: 100%;
        background: var(--mobi-blue);
        transition: width 1s linear;
      }
    }
    .note {
      margin: 0;
      font-size: 11px;
      color: var(--text-subtle);
    }
    .card.left {
      right: auto;
      left: 20px;
    }
    @media (max-width: 600px) {
      .card,
      .card.left { left: auto; right: 16px; bottom: 16px; }
    }
  `,
})
export class DemoAuthenticator {
  private readonly backend = inject(MockBackend);
  private readonly auth = inject(AuthService);
  private readonly demo = inject(DemoAuthenticatorService);

  protected readonly reading = signal<Reading | null>(null);
  protected readonly signedIn = computed(() => !!this.auth.session());
  protected readonly minimised = signal(false);
  protected readonly copied = signal(false);

  constructor() {
    const timer = setInterval(() => void this.read(), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    // React immediately when the screen changes which authenticator it is waiting for.
    effect(() => {
      this.auth.pending();
      this.auth.session();
      this.demo.replacement();
      this.demo.sessionWanted();
      void this.read();
    });
  }

  private async read() {
    const replacement = this.demo.replacement();
    const pending = this.auth.pending();
    const sessionToken = this.auth.session() && this.demo.sessionWanted() ? this.auth.token : null;
    try {
      const r = replacement
        ? await this.backend.server.demoAuthenticator('replace', replacement.token)
        : pending
          ? await this.backend.server.demoAuthenticator('challenge', pending.challengeToken)
          : sessionToken
            ? await this.backend.server.demoAuthenticator('session', sessionToken)
            : null;
      this.reading.set(r);
    } catch {
      this.reading.set(null);
    }
  }

  protected async copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      // The code is still visible to type in.
    }
  }
}
