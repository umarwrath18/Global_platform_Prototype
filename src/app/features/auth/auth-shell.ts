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
        <!-- Decorative brand photo (Mobi mark, Kuala Lumpur skyline). Hidden from assistive tech. -->
        <div class="hero"></div>

        <app-mobi-logo class="brand-logo" [showProduct]="false" style="--logo-size: 40px" />
        <div class="copy">
          <p class="tagline">Borderless Payments,<br />Built for Global Businesses<span class="dot">.</span></p>
        </div>
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

    /* Brand panel: full-bleed brand photo, navy behind it while it loads. */
    .brand {
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      padding: 56px 64px 72px;
      background: var(--nav-bg);
      color: #fff;
    }

    .brand-logo,
    .copy {
      position: relative;
      z-index: 2;
    }

    .copy {
      margin-top: auto;
      padding-top: 32px;
    }

    .tagline {
      max-width: 640px;
      margin: 0;
      font-size: clamp(32px, 2.8vw, 46px);
      line-height: 1.15;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    /* ---- Brand photo ---- */
    .hero {
      position: absolute;
      inset: 0;
      z-index: 1;
      background: url('/brand/login-hero.webp') 34% center / cover no-repeat;
      pointer-events: none;
    }

    /* Darkens the top (logo) and bottom (tagline) so the white text stays readable. */
    .hero::after {
      content: '';
      position: absolute;
      inset: 0;
      background:
        linear-gradient(180deg, rgba(5, 10, 14, 0.55) 0%, rgba(5, 10, 14, 0) 22%),
        linear-gradient(0deg, rgba(5, 10, 14, 0.85) 0%, rgba(5, 10, 14, 0.35) 30%, rgba(5, 10, 14, 0) 50%);
    }

    .tagline .dot {
      color: var(--mobi-green);
    }

    /* ---- Form side ---- */
    .panel {
      display: flex;
      flex-direction: column;
      min-width: 0;
      background: var(--surface);
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

    @media (prefers-reduced-motion: no-preference) {
      .hero {
        animation: hero-in 0.8s ease-out both;
      }
      @keyframes hero-in {
        from {
          opacity: 0;
        }
      }
    }
  `,
})
export class AuthShell {}
