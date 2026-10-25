import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Official Mobi wordmark (brand assets in /public/brand). White on dark surfaces, blue on light. */
@Component({
  selector: 'app-mobi-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.dark]': "tone() === 'dark'", role: 'img', '[attr.aria-label]': "'Mobi' + (showProduct() ? ' Platform' : '')" },
  template: `
    <img
      class="wordmark"
      [src]="tone() === 'dark' ? 'brand/mobi-wordmark-blue.png' : 'brand/mobi-wordmark-white.png'"
      alt=""
      aria-hidden="true"
      draggable="false"
    />
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
      .product { color: var(--text-muted); }
      .divider { background: var(--border); }
    }
    .wordmark {
      display: block;
      /* --logo-size keeps the previous sizing contract: the visual height of the wordmark. */
      height: calc(var(--logo-size, 64px) * 0.78);
      width: auto;
      user-select: none;
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
