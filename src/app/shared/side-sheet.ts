import { DOCUMENT } from '@angular/common';
import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, inject, input, OnDestroy, output, ViewEncapsulation } from '@angular/core';

/**
 * Side sheet (Mobi design system): slides in from the right over a dimmed page, so the list behind
 * stays visible. Two sizes: `detail` (560 px) for viewing and deciding, `editor` (640 px) for forms.
 * Full screen below 768 px. The content provides its own header, scrolling body and footer with the
 * `sheet-head`, `sheet-body` and `sheet-foot` classes (or any column layout).
 *
 * Esc and a click on the backdrop emit `dismiss`; the host decides (e.g. ask before discarding a
 * draft). Focus moves into the sheet when it opens, stays inside it, and returns to the element that
 * opened it when it closes. The page behind doesn't scroll while it's open.
 */
@Component({
  selector: 'app-side-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: `
    <div class="sheet-backdrop" (click)="dismiss.emit()" aria-hidden="true"></div>
    <section class="sheet-panel" [class.editor]="size() === 'editor'" role="dialog" aria-modal="true" [attr.aria-label]="label()" (keydown)="onKeydown($event)" tabindex="-1">
      <ng-content />
    </section>
  `,
  styles: `
    app-side-sheet {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: block;
    }
    app-side-sheet .sheet-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(11, 26, 46, 0.48);
      animation: sheet-fade 200ms ease-out;
    }
    app-side-sheet .sheet-panel {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(560px, 100%);
      display: flex;
      flex-direction: column;
      background: var(--surface);
      border-radius: 16px 0 0 16px;
      box-shadow: -24px 0 48px -16px rgba(16, 24, 40, 0.28);
      animation: sheet-in 240ms cubic-bezier(0.2, 0.8, 0.2, 1);
      outline: none;
    }
    app-side-sheet .sheet-panel.editor {
      width: min(640px, 100%);
    }
    @media (max-width: 767px) {
      app-side-sheet .sheet-panel,
      app-side-sheet .sheet-panel.editor {
        width: 100%;
        border-radius: 0;
        animation-name: sheet-up;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      app-side-sheet .sheet-panel,
      app-side-sheet .sheet-backdrop {
        animation: sheet-fade 120ms linear;
      }
    }
    @keyframes sheet-in {
      from { transform: translateX(48px); opacity: 0; }
      to { transform: none; opacity: 1; }
    }
    @keyframes sheet-up {
      from { transform: translateY(32px); opacity: 0; }
      to { transform: none; opacity: 1; }
    }
    @keyframes sheet-fade {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    /* Shared sheet layout: header, scrolling body, footer that stays put. */
    .sheet-head {
      display: flex;
      align-items: flex-start;
      gap: 16px;
      padding: 24px 28px 20px;
      border-bottom: 1px solid var(--border-soft);
    }
    .sheet-head .sheet-titles {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .sheet-eyebrow {
      margin: 0;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--text-muted);
    }
    .sheet-title {
      margin: 0;
      font-size: 22px;
      line-height: 1.25;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 12px;
    }
    .sheet-sub {
      margin: 0;
      font-size: 14px;
      color: var(--text-muted);
    }
    .sheet-close {
      flex: 0 0 auto;
      width: 40px;
      height: 40px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--surface);
      color: var(--text);
      cursor: pointer;
    }
    .sheet-close:hover { background: var(--surface-muted); }
    .sheet-close:focus-visible { outline: none; box-shadow: var(--focus-ring); }
    .sheet-body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 24px 28px;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }
    .sheet-section {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .sheet-section > h3 {
      margin: 0;
      font-size: 15px;
    }
    .sheet-foot {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      padding: 16px 28px;
      border-top: 1px solid var(--border);
      background: var(--surface);
    }
    .sheet-foot .sheet-foot-note {
      flex: 1;
      min-width: 0;
      font-size: 13px;
      color: var(--text-muted);
    }
    .sheet-foot .btn { min-height: 44px; }
    .sheet-confirm {
      border-top: 1px solid var(--border);
      box-shadow: 0 -16px 32px -16px rgba(16, 24, 40, 0.18);
      padding: 20px 28px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      background: var(--surface);
    }
    .sheet-confirm h3 { margin: 0; font-size: 16px; }
    .sheet-confirm p { margin: 0; font-size: 14px; color: var(--text-muted); line-height: 1.5; }
    .sheet-confirm .sheet-confirm-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 12px; }
    @media (max-width: 767px) {
      .sheet-head, .sheet-body, .sheet-foot, .sheet-confirm { padding-left: 16px; padding-right: 16px; }
    }

    /* Description list in two columns. */
    .sheet-dl {
      margin: 0;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px 24px;
      font-size: 14px;
    }
    .sheet-dl dt { font-size: 12px; color: var(--text-muted); }
    .sheet-dl dd { margin: 2px 0 0; overflow-wrap: anywhere; }
    .sheet-dl .wide { grid-column: 1 / -1; }
    @media (max-width: 480px) { .sheet-dl { grid-template-columns: minmax(0, 1fr); } }

    /* Current → New comparison. */
    .sheet-compare {
      border: 1px solid var(--border);
      border-radius: var(--r-card);
      overflow: hidden;
      font-size: 14px;
    }
    .sheet-compare .row {
      display: grid;
      grid-template-columns: 110px minmax(0, 1fr) minmax(0, 1fr);
      gap: 12px;
      padding: 12px 16px;
      border-top: 1px solid var(--border-soft);
    }
    .sheet-compare .row.head {
      border-top: 0;
      background: var(--surface-page);
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .sheet-compare .k, .sheet-compare .was { color: var(--text-muted); }
    .sheet-compare .now { font-weight: 600; }
    .sheet-compare .row.foot { display: block; background: var(--surface-page); font-size: 13px; color: var(--text-muted); }
    @media (max-width: 480px) { .sheet-compare .row { grid-template-columns: minmax(0, 1fr); gap: 2px; } }

    /* Activity timeline. */
    .sheet-timeline { list-style: none; margin: 0; padding: 0; font-size: 14px; }
    .sheet-timeline li { position: relative; display: flex; gap: 12px; padding-bottom: 14px; }
    .sheet-timeline li::before { content: ''; flex: 0 0 10px; height: 10px; margin-top: 5px; border-radius: 50%; background: var(--mobi-blue); }
    .sheet-timeline li.waiting::before { background: transparent; border: 2px dashed #dc6803; box-sizing: border-box; }
    .sheet-timeline li.bad::before { background: var(--danger); }
    .sheet-timeline li:not(:last-child)::after { content: ''; position: absolute; left: 4px; top: 18px; bottom: 0; width: 2px; background: var(--border); }
    .sheet-timeline .meta { font-size: 13px; color: var(--text-muted); }

    /* Locked scope chips. */
    .sheet-locked { border: 1px solid var(--border); border-radius: var(--r-card); overflow: hidden; }
    .sheet-locked .lock-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: var(--surface-page); font-size: 13px; color: var(--text-muted); }
    .sheet-locked .chips { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 14px 4px; }
    .sheet-locked .chip { padding: 5px 10px; border-radius: 999px; background: var(--mobi-blue-tint); color: var(--brand-dark); font-size: 13px; font-weight: 600; }
    .sheet-locked .existing { padding: 8px 14px 12px; font-size: 13px; color: var(--text-muted); }

    /* One-time code input. */
    .code-input {
      width: 100%;
      max-width: 260px;
      height: 56px;
      padding: 0 16px;
      border: 1px solid var(--border-strong);
      border-radius: 10px;
      font: inherit;
      font-size: 24px;
      font-weight: 600;
      letter-spacing: 0.5em;
      font-variant-numeric: tabular-nums;
    }
    .code-input:focus { outline: none; border-color: var(--mobi-blue); box-shadow: var(--focus-ring); }
  `,
})
export class SideSheet implements AfterViewInit, OnDestroy {
  readonly size = input<'detail' | 'editor'>('detail');
  /** Accessible name of the dialog (usually its title). */
  readonly label = input.required<string>();
  readonly dismiss = output<void>();

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly doc = inject(DOCUMENT);
  private readonly opener = this.doc.activeElement as HTMLElement | null;
  private readonly overflow = this.doc.body.style.overflow;

  ngAfterViewInit() {
    this.doc.body.style.overflow = 'hidden';
    // Focus the first field or button in the body, else the panel itself.
    queueMicrotask(() => {
      const panel = this.panel();
      const first = panel?.querySelector<HTMLElement>('.sheet-body input:not([disabled]), .sheet-body select:not([disabled]), .sheet-body textarea:not([disabled]), [autofocus]');
      (first ?? panel)?.focus({ preventScroll: true });
    });
  }

  ngOnDestroy() {
    this.doc.body.style.overflow = this.overflow;
    if (this.opener && this.doc.contains(this.opener)) this.opener.focus({ preventScroll: true });
  }

  protected onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.dismiss.emit();
      return;
    }
    if (e.key !== 'Tab') return;
    // Keep focus inside the sheet.
    const items = this.focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = this.doc.activeElement;
    if (e.shiftKey && (active === first || active === this.panel())) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  private panel() {
    return this.el.nativeElement.querySelector<HTMLElement>('.sheet-panel');
  }

  private focusables(): HTMLElement[] {
    const panel = this.panel();
    if (!panel) return [];
    return [...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null || x === this.doc.activeElement);
  }
}
