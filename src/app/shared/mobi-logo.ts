import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Approximation of the Mobi wordmark built from text + SVG.
 * Replace with the official SVG asset once supplied by Brand.
 */
@Component({
  selector: 'app-mobi-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.dark]': "tone() === 'dark'", role: 'img', '[attr.aria-label]': "'Mobi' + (showProduct() ? ' Platform' : '')" },
  template: `
    <span class="wordmark" aria-hidden="true">
      m<svg class="o" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" stroke-width="10" />
        <path d="M20 1 A19 19 0 0 1 39 20 L29.5 20 A9.5 9.5 0 0 0 20 10.5 Z" fill="var(--mobi-green)" />
      </svg>bi
    </span>
    @if (showProduct()) {
      <span class="divider" aria-hidden="true"></span>
      <span class="product" aria-hidden="true">Mobi Platform</span>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: 24px;
      color: #fff;
    }
    :host(.dark) {
      color: var(--mobi-blue);
      .product { color: var(--text-muted); }
      .divider { background: var(--border); }
    }
    .wordmark {
      display: inline-flex;
      align-items: flex-end;
      font-size: var(--logo-size, 64px);
      font-weight: 800;
      line-height: 0.8;
      letter-spacing: -0.06em;
    }
    .o {
      width: 0.6em;
      height: 0.6em;
      margin: 0 0.02em 0.01em 0.03em;
    }
    .divider {
      width: 1px;
      height: 28px;
      background: rgba(255, 255, 255, 0.4);
    }
    .product {
      font-size: 18px;
      font-weight: 400;
      color: rgba(255, 255, 255, 0.9);
    }
  `,
})
export class MobiLogo {
  readonly tone = input<'light' | 'dark'>('light');
  readonly showProduct = input(true);
}
