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
        <div class="glow"></div>

        <!-- Decorative preview of the signed-in workspace. Not interactive, hidden from assistive tech. -->
        <div class="preview">
          <div class="win">
            <div class="win-side">
              <span class="ws-logo"></span>
              <span class="ws-item on"></span>
              <span class="ws-item"></span>
              <span class="ws-item"></span>
              <span class="ws-item"></span>
              <span class="ws-gap"></span>
              <span class="ws-item dim"></span>
              <span class="ws-item dim"></span>
              <span class="ws-item dim"></span>
            </div>
            <div class="win-main">
              <div class="win-top"><span></span><span></span><span></span><span class="grow"></span><span class="pill"></span></div>
              <p class="win-title">Overview</p>
              <div class="kpis">
                <div class="kpi"><span>Merchants</span><strong>8</strong><svg viewBox="0 0 100 28" preserveAspectRatio="none"><path d="M0 24 L18 22 L36 22 L54 18 L72 18 L86 9 L100 4" /></svg></div>
                <div class="kpi"><span>Applications</span><strong>13</strong><svg viewBox="0 0 100 28" preserveAspectRatio="none"><path d="M0 25 L20 23 L40 21 L60 20 L80 14 L100 6" /></svg></div>
                <div class="kpi"><span>Pending review</span><strong>2</strong></div>
                <div class="kpi"><span>Operational</span><strong>3</strong></div>
              </div>
              <div class="panels">
                <div class="panel-mock">
                  <span class="pm-title">By country</span>
                  @for (row of bars; track $index) {
                    <div class="bar-row"><span class="bar-label"></span><span class="bar">@for (seg of row; track $index) {<i [class]="seg.c" [style.flex]="seg.v"></i>}</span></div>
                  }
                </div>
                <div class="panel-mock">
                  <span class="pm-title">Needs attention</span>
                  @for (i of [1, 2, 3]; track i) {
                    <div class="att"><span class="att-ic" [class]="'att-ic t' + i"></span><span class="att-lines"><i></i><i></i></span></div>
                  }
                </div>
              </div>
            </div>
          </div>
        </div>

        <app-mobi-logo class="brand-logo" [showProduct]="false" style="--logo-size: 40px" />
        <div class="copy">
          <p class="tagline">Borderless Payments,<br />Built for Global Businesses.</p>
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

    /* Dark brand panel: same navy as the signed-in sidebar, with a faded workspace preview. */
    .brand {
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      padding: 56px 64px 72px;
      background: var(--nav-bg);
      color: #fff;
    }

    .glow {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background:
        radial-gradient(60% 50% at 85% 25%, rgba(11, 92, 171, 0.45) 0%, rgba(11, 92, 171, 0) 70%),
        radial-gradient(45% 40% at 10% 100%, rgba(1, 123, 139, 0.35) 0%, rgba(1, 123, 139, 0) 70%);
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

    /* ---- Workspace preview ---- */
    .preview {
      position: absolute;
      z-index: 1;
      top: 15%;
      left: 22%;
      width: 900px;
      transform: perspective(1800px) rotateY(-14deg) rotateX(6deg) rotate(-2deg);
      transform-origin: left top;
      opacity: 0.55;
      mask-image: linear-gradient(180deg, #000 0%, #000 45%, transparent 78%), linear-gradient(90deg, #000 55%, transparent 100%);
      -webkit-mask-image: linear-gradient(180deg, #000 0%, #000 45%, transparent 78%);
      mask-composite: intersect;
      pointer-events: none;
    }

    .win {
      display: flex;
      height: 560px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      background: #f6f8fb;
      box-shadow: 0 40px 80px -30px rgba(0, 0, 0, 0.6);
    }

    .win-side {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 150px;
      padding: 18px 12px;
      background: #0e2036;
    }

    .ws-logo {
      width: 54px;
      height: 14px;
      margin-bottom: 14px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.85);
    }

    .ws-item {
      height: 22px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.1);

      &.on {
        background: #0b5cab;
      }

      &.dim {
        background: rgba(255, 255, 255, 0.05);
      }
    }

    .ws-gap {
      height: 10px;
    }

    .win-main {
      flex: 1;
      padding: 14px 20px;
      color: #101828;
    }

    .win-top {
      display: flex;
      gap: 8px;
      margin-bottom: 18px;

      span {
        width: 90px;
        height: 22px;
        border: 1px solid #e3e8ef;
        border-radius: 6px;
        background: #fff;
      }

      .grow {
        flex: 1;
        border: 0;
        background: none;
      }

      .pill {
        width: 130px;
      }
    }

    .win-title {
      margin: 0 0 12px;
      font-size: 18px;
      font-weight: 700;
    }

    .kpis {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-bottom: 12px;
    }

    .kpi {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 4px;
      height: 78px;
      padding: 10px 12px;
      overflow: hidden;
      border: 1px solid #e3e8ef;
      border-radius: 10px;
      background: #fff;

      span {
        font-size: 10px;
        color: #5b6675;
      }

      strong {
        font-size: 20px;
      }

      svg {
        position: absolute;
        right: 0;
        bottom: 10px;
        width: 55%;
        height: 26px;
      }

      path {
        fill: none;
        stroke: #8ab6e4;
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
      }
    }

    .panels {
      display: grid;
      grid-template-columns: 1.5fr 1fr;
      gap: 10px;
    }

    .panel-mock {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      border: 1px solid #e3e8ef;
      border-radius: 10px;
      background: #fff;
    }

    .pm-title {
      font-size: 11px;
      font-weight: 600;
    }

    .bar-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .bar-label {
      width: 48px;
      height: 7px;
      border-radius: 4px;
      background: #e3e8ef;
    }

    .bar {
      display: flex;
      flex: 1;
      gap: 2px;
      height: 7px;
      overflow: hidden;
      border-radius: 4px;
      background: #eef1f5;

      i {
        display: block;
      }

      .g { background: #12a150; }
      .b { background: #2e7bd1; }
      .l { background: #93c0ec; }
      .a { background: #f5a524; }
      .r { background: #e5484d; }
      .e { background: transparent; }
    }

    .att {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .att-ic {
      width: 18px;
      height: 18px;
      border-radius: 5px;
      background: #eaf3fc;

      &.t2 { background: #fffaeb; }
    }

    .att-lines {
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: 4px;

      i {
        display: block;
        height: 6px;
        border-radius: 3px;
        background: #e3e8ef;

        & + i {
          width: 60%;
          background: #eef1f5;
        }
      }
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

    @media (max-width: 1280px) {
      .preview {
        left: 14%;
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
      .preview {
        animation: preview-in 0.8s ease-out both;
      }
      @keyframes preview-in {
        from {
          opacity: 0;
          translate: 24px 12px;
        }
      }
    }
  `,
})
export class AuthShell {
  /** Proportions for the decorative "By country" bars (g = live, b = readiness, l = review, a = returned, r = rejected). */
  protected readonly bars = [
    [{ c: 'g', v: 1 }, { c: 'l', v: 2 }, { c: 'e', v: 1 }],
    [{ c: 'g', v: 1 }, { c: 'a', v: 1 }, { c: 'e', v: 2 }],
    [{ c: 'g', v: 1 }, { c: 'l', v: 1 }, { c: 'r', v: 1 }, { c: 'e', v: 1 }],
    [{ c: 'b', v: 2 }, { c: 'e', v: 2 }],
    [{ c: 'b', v: 1 }, { c: 'r', v: 1 }, { c: 'e', v: 2 }],
  ];
}
