import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MobiLogo } from '../../shared/mobi-logo';

/** Split-screen layout shared by the Login and Forgot Password screens. */
@Component({
  selector: 'app-auth-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobiLogo],
  host: { class: 'auth-screen' },
  template: `
    <div class="shell">
      <aside class="brand" aria-hidden="true">
        <div class="streaks"></div>
        <app-mobi-logo class="brand-logo" tone="dark" [showProduct]="false" style="--logo-size: 40px" />
        <p class="tagline">Borderless Payments,<br />Built for Global Businesses.</p>
      </aside>

      <main class="panel">
        <header class="mobile-header">
          <app-mobi-logo tone="dark" [showProduct]="false" style="--logo-size: 34px" />
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
      grid-template-columns: minmax(0, 1fr) minmax(480px, 38%);
      min-height: 100vh;
      min-height: 100dvh;
    }

    /* Light brand panel: soft sky gradient with diagonal light streaks in Mobi blues. */
    .brand {
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      padding: 56px 64px 72px;
      background:
        radial-gradient(70% 55% at 0% 100%, rgba(255, 255, 255, 0.95) 0%, rgba(255, 255, 255, 0) 70%),
        radial-gradient(60% 60% at 100% 0%, rgba(255, 255, 255, 0.9) 0%, rgba(255, 255, 255, 0) 65%),
        linear-gradient(135deg, #f5fcff 0%, #e2f4fd 36%, #cdeefb 60%, #e9f9fb 100%);
    }

    .streaks {
      position: absolute;
      inset: -20%;
      pointer-events: none;
      background:
        repeating-linear-gradient(
          112deg,
          rgba(255, 255, 255, 0) 0 60px,
          rgba(255, 255, 255, 0.85) 90px,
          rgba(255, 255, 255, 0) 130px,
          rgba(110, 200, 240, 0.35) 160px,
          rgba(170, 235, 215, 0.25) 175px,
          rgba(255, 255, 255, 0) 210px,
          rgba(0, 92, 172, 0.08) 250px,
          rgba(255, 255, 255, 0) 290px 340px
        );
      filter: blur(10px);
      mask-image: linear-gradient(115deg, transparent 8%, #000 30%, #000 70%, transparent 95%);
      -webkit-mask-image: linear-gradient(115deg, transparent 8%, #000 30%, #000 70%, transparent 95%);
    }

    .brand-logo {
      position: relative;
    }

    .tagline {
      position: relative;
      max-width: 640px;
      margin: auto 0 0;
      font-size: clamp(32px, 2.8vw, 46px);
      line-height: 1.15;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--brand-dark);
    }

    .panel {
      display: flex;
      flex-direction: column;
      min-width: 0;
      background: var(--surface);
      box-shadow: -1px 0 0 var(--border-soft);
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
      max-width: 520px;
      padding: 56px 64px 32px;
    }

    .footer {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      max-width: 520px;
      padding: 0 64px 28px;
      font-size: 12px;
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
        grid-template-columns: minmax(0, 1fr);
      }
      .brand {
        display: none;
      }
      .mobile-header {
        display: block;
        padding: 24px 20px 0;
      }
      .content {
        max-width: 480px;
        justify-content: flex-start;
        margin: 0 auto;
        padding: 32px 20px;
      }
      .footer {
        flex-direction: column;
        align-items: center;
        max-width: none;
        padding: 0 16px 24px;
      }
    }
  `,
})
export class AuthShell {}
