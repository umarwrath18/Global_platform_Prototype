import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MobiLogo } from '../../shared/mobi-logo';

/** Split-screen layout shared by the Login and Forgot Password screens. */
@Component({
  selector: 'app-auth-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobiLogo],
  template: `
    <div class="shell">
      <aside class="brand" aria-hidden="true">
        <div class="rings"></div>
        <app-mobi-logo class="brand-logo" />
        <p class="tagline">Borderless Payments, Built for Global Businesses.</p>
      </aside>

      <main class="panel">
        <header class="mobile-header">
          <app-mobi-logo tone="dark" style="--logo-size: 44px" />
        </header>
        <div class="content">
          <ng-content />
        </div>
        <footer class="footer">
          <span>© 2026 Mobi Asia Sdn Bhd</span>
          <nav aria-label="Legal">
            <a href="#" (click)="$event.preventDefault()">Privacy</a> ·
            <a href="#" (click)="$event.preventDefault()">Security</a> ·
            <a href="#" (click)="$event.preventDefault()">Terms</a>
          </nav>
        </footer>
      </main>
    </div>
  `,
  styles: `
    .shell {
      display: grid;
      grid-template-columns: minmax(0, 46fr) minmax(0, 54fr);
      min-height: 100vh;
      min-height: 100dvh;
    }

    .brand {
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      padding: 60px 70px;
      color: #fff;
      background:
        radial-gradient(120% 80% at 100% 100%, rgba(1, 123, 139, 0.95) 0%, rgba(1, 123, 139, 0) 60%),
        linear-gradient(160deg, var(--brand-dark) 0%, #0053a0 45%, #0160a6 75%, #01708f 100%);
    }

    .rings {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background:
        radial-gradient(circle at 96% 15%, transparent 0 370px, rgba(255, 255, 255, 0.07) 371px 485px, transparent 486px),
        radial-gradient(circle at 96% 15%, transparent 0 485px, rgba(255, 255, 255, 0.045) 486px 610px, transparent 611px),
        radial-gradient(circle at -10% 105%, transparent 0 300px, rgba(255, 255, 255, 0.06) 301px 420px, transparent 421px);
    }

    .brand-logo {
      position: relative;
    }

    .tagline {
      position: relative;
      margin: auto 0;
      max-width: 760px;
      font-size: clamp(40px, 3.4vw, 62px);
      line-height: 1.12;
      font-weight: 500;
      letter-spacing: -0.02em;
    }

    .panel {
      display: flex;
      flex-direction: column;
      min-width: 0;
      background: linear-gradient(180deg, #fff 0%, var(--surface-page) 100%);
    }

    .mobile-header {
      display: none;
    }

    .content {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      width: 100%;
      max-width: 620px;
      margin: 0 auto;
      padding: 48px 24px;
    }

    .footer {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 0 36px 26px;
      font-size: 13px;
      color: var(--text-subtle);

      a {
        color: inherit;
        text-decoration: none;

        &:hover {
          color: var(--text-muted);
          text-decoration: underline;
        }
      }
    }

    @media (max-width: 960px) {
      .shell {
        grid-template-columns: 1fr;
      }
      .brand {
        display: none;
      }
      .mobile-header {
        display: block;
        padding: 28px 24px 0;
      }
      .content {
        justify-content: flex-start;
        padding: 40px 16px;
      }
      .footer {
        flex-direction: column;
        align-items: center;
        padding: 0 16px 24px;
      }
    }
  `,
})
export class AuthShell {}
