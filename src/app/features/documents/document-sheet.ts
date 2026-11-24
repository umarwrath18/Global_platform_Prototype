import { ChangeDetectionStrategy, Component, computed, inject, input, OnDestroy, OnInit, output, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { DocumentFiles, fileSizeLabel, fileTypeLabel, previewKind } from '../../core/documents/document-files';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import { DocumentRecord, HistoryEvent, STAFF_ROLE_LABEL } from '../../core/merchants/merchant-models';
import { Icon } from '../../shared/icon';
import { fmtDate, fmtDateTime } from '../../shared/merchant-ui';
import { SideSheet } from '../../shared/side-sheet';

type FileState = 'loading' | 'ready' | 'sample' | 'missing';

/**
 * One application document in a side sheet: a preview (PDF in the browser's viewer, images inline
 * with zoom), the file details, Open in new tab and Download. Opening the sheet and downloading are
 * recorded in the application history by the server, which also checks the team (Sales / Operations,
 * Risk, CS). Demo records have no file and show a sample page.
 */
@Component({
  selector: 'app-document-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, SideSheet],
  template: `
@let d = doc();
<app-side-sheet size="wide" [label]="typeLabel()" (dismiss)="closed.emit()">
  <header class="sheet-head">
    <div class="sheet-titles">
      <p class="sheet-eyebrow">{{ eyebrow() }}</p>
      <h2 class="sheet-title">{{ typeLabel() }}</h2>
      <p class="sheet-sub">{{ subtitle() }}</p>
    </div>
    <button type="button" class="sheet-close" (click)="closed.emit()" aria-label="Close"><app-icon name="x" [size]="18" /></button>
  </header>

  <div class="doc-body">
    <div class="doc-viewer" aria-label="Preview">
      @switch (state()) {
        @case ('loading') {<div class="doc-msg"><span class="spinner" aria-hidden="true"></span>Loading the file…</div>}
        @case ('ready') {
          @if (kind() === 'pdf') {
            <iframe class="doc-pdf" [src]="safeUrl()" [title]="d.fileName"></iframe>
          } @else {
            <div class="doc-bar">
              <span>{{ d.fileName }}</span>
              <span class="doc-zoom">
                <button type="button" (click)="zoomBy(-25)" [disabled]="zoom() <= 50" aria-label="Zoom out">−</button>
                <button type="button" (click)="zoom.set(100)" aria-label="Reset zoom">{{ zoom() }}%</button>
                <button type="button" (click)="zoomBy(25)" [disabled]="zoom() >= 300" aria-label="Zoom in">+</button>
              </span>
            </div>
            <div class="doc-img-wrap"><img [src]="url()" [alt]="typeLabel() + ': ' + d.fileName" [style.width.%]="zoom()" /></div>
          }
        }
        @case ('sample') {
          <div class="doc-page" role="img" aria-label="Sample document">
            <span class="doc-stamp" aria-hidden="true">SAMPLE</span>
            <span class="doc-icon"><app-icon name="file" [size]="26" /></span>
            <strong>Sample document</strong>
            <span>This demo record has no file attached. Documents you upload in this browser open here.</span>
            <span class="doc-small">{{ d.fileName }} · {{ size() }}</span>
          </div>
        }
        @case ('missing') {
          <div class="doc-page">
            <span class="doc-icon"><app-icon name="file" [size]="26" /></span>
            <strong>File not in this browser</strong>
            <span>In this prototype, files stay in the browser they were uploaded from. Open this application in that browser to see the file.</span>
            <span class="doc-small">{{ d.fileName }} · {{ size() }}</span>
          </div>
        }
      }
    </div>

    <aside class="doc-side">
      <h3>File</h3>
      <dl>
        <dt>Document type</dt><dd>{{ typeLabel() }}</dd>
        <dt>File name</dt><dd>{{ d.fileName }}</dd>
        <dt>Size</dt><dd>{{ type() }} · {{ size() }}</dd>
        <dt>Uploaded by</dt><dd>{{ uploader() }}</dd>
        <dt>Uploaded</dt><dd>{{ d.sample ? date(d.uploadedAt) : dateTime(d.uploadedAt) }}</dd>
      </dl>
      <p class="doc-audit">Opening and downloading are recorded in the application history.</p>
      @if (error(); as e) {<div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e }}</div></div>}
    </aside>
  </div>

  <footer class="sheet-foot">
    @if (state() === 'ready') {
      <span class="sheet-foot-note"></span>
      <button type="button" class="btn" (click)="openInTab()">Open in new tab</button>
      <button type="button" class="btn primary" (click)="download()" [disabled]="busy()">Download</button>
    } @else {
      <span class="sheet-foot-note">{{ state() === 'sample' ? 'No file to download for demo records.' : state() === 'missing' ? 'No file to download in this browser.' : '' }}</span>
      <button type="button" class="btn" disabled>Download</button>
    }
  </footer>
</app-side-sheet>
  `,
  styles: `
    .doc-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 240px; }
    .doc-viewer { min-height: 0; display: flex; flex-direction: column; background: #525a66; }
    .doc-pdf { flex: 1; width: 100%; min-height: 0; border: 0; background: #525a66; }
    .doc-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 16px; color: #e6eaf0; font-size: 12px; }
    .doc-bar > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .doc-zoom { display: inline-flex; gap: 4px; flex: 0 0 auto; }
    .doc-zoom button { min-width: 32px; height: 28px; padding: 0 8px; border: 0; border-radius: 6px; background: #3d444f; color: #fff; font: inherit; font-size: 12px; cursor: pointer; }
    .doc-zoom button:disabled { opacity: 0.5; cursor: default; }
    .doc-zoom button:focus-visible { outline: 2px solid #fff; }
    .doc-img-wrap { flex: 1; min-height: 0; overflow: auto; padding: 0 16px 16px; text-align: center; }
    .doc-img-wrap img { max-width: none; background: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35); }
    .doc-msg { margin: auto; display: flex; align-items: center; gap: 10px; color: #e6eaf0; }
    .doc-page { position: relative; overflow: hidden; margin: auto; width: min(400px, calc(100% - 32px)); min-height: 420px; padding: 32px; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; background: #fff; border-radius: 3px; color: var(--text-muted); }
    .doc-page strong { font-size: 16px; color: var(--text); }
    .doc-small { font-size: 13px; }
    .doc-stamp { position: absolute; top: 36px; right: -44px; transform: rotate(30deg); padding: 4px 52px; border: 1.5px dashed #d63384; background: #fdf2f8; color: #a61e6b; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; }
    .doc-icon { width: 56px; height: 56px; display: grid; place-items: center; border-radius: 12px; background: var(--mobi-blue-tint); color: var(--mobi-blue); }
    .doc-side { min-width: 0; overflow-y: auto; padding: 20px; border-left: 1px solid var(--border-soft); display: flex; flex-direction: column; gap: 14px; }
    .doc-side h3 { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-muted); }
    .doc-side dl { margin: 0; }
    .doc-side dt { font-size: 12px; color: var(--text-muted); }
    .doc-side dd { margin: 2px 0 12px; font-weight: 600; overflow-wrap: anywhere; }
    .doc-audit { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--surface-muted); font-size: 12px; color: var(--text-muted); }
    @media (max-width: 767px) {
      /* Phones: preview first, then the file details, one scrolling column. */
      .doc-body { display: block; overflow-y: auto; }
      .doc-viewer { padding: 16px 0; min-height: 320px; }
      .doc-pdf { flex: none; height: 65vh; }
      .doc-img-wrap { max-height: 65vh; }
      .doc-page { min-height: 300px; padding: 24px; }
      .doc-side { border-left: 0; border-top: 1px solid var(--border-soft); overflow: visible; }
    }
  `,
})
export class DocumentSheet implements OnInit, OnDestroy {
  private readonly api = inject(MerchantApi);
  private readonly files = inject(DocumentFiles);
  private readonly sanitizer = inject(DomSanitizer);

  readonly doc = input.required<DocumentRecord>();
  readonly typeLabel = input.required<string>();
  /** Merchant · application · country. */
  readonly subtitle = input('');
  readonly applicationId = input.required<string>();
  readonly eyebrow = input('Document');
  readonly closed = output<void>();
  /** The application history after an open or download was recorded. */
  readonly recorded = output<HistoryEvent[]>();

  protected readonly state = signal<FileState>('loading');
  protected readonly url = signal<string | null>(null);
  protected readonly zoom = signal(100);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly kind = computed(() => previewKind(this.doc().fileName));
  protected readonly type = computed(() => fileTypeLabel(this.doc().fileName));
  protected readonly size = computed(() => fileSizeLabel(this.doc().sizeKb));
  protected readonly safeUrl = computed<SafeResourceUrl | null>(() => {
    const u = this.url();
    // A blob: URL this sheet created from a file stored in this browser.
    return u ? this.sanitizer.bypassSecurityTrustResourceUrl(u) : null;
  });
  protected readonly uploader = computed(() => {
    const d = this.doc();
    if (d.sample) return 'Demo data';
    if (!d.uploadedBy) return 'Not recorded';
    return d.uploadedByRole ? `${d.uploadedBy} · ${STAFF_ROLE_LABEL[d.uploadedByRole]}` : d.uploadedBy;
  });
  protected readonly date = fmtDate;
  protected readonly dateTime = (t: number) => fmtDateTime(t);

  async ngOnInit() {
    void this.record('view');
    const d = this.doc();
    if (d.sample) return this.state.set('sample');
    const blob = await this.files.get(d.id);
    if (!blob) return this.state.set('missing');
    this.url.set(URL.createObjectURL(blob));
    this.state.set('ready');
  }

  ngOnDestroy() {
    const u = this.url();
    if (u) URL.revokeObjectURL(u);
  }

  protected zoomBy(step: number) {
    this.zoom.update((z) => Math.min(300, Math.max(50, z + step)));
  }

  protected openInTab() {
    const u = this.url();
    if (u) window.open(u, '_blank', 'noopener');
  }

  protected async download() {
    const u = this.url();
    if (!u) return;
    this.busy.set(true);
    const a = document.createElement('a');
    a.href = u;
    a.download = this.doc().fileName;
    a.click();
    await this.record('download');
    this.busy.set(false);
  }

  private async record(action: 'view' | 'download') {
    try {
      const res = await this.api.documentAccess(this.applicationId(), this.doc().id, action);
      this.recorded.emit(res.history);
    } catch (e) {
      this.error.set(toMerchantError(e).message ?? "We couldn't record this in the application history.");
    }
  }
}
