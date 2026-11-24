/**
 * One-page PDF for a transaction document (Sales slip, Payment advice), written by hand so no PDF
 * library is needed: Helvetica text plus the Mobi logo as a JPEG image. A5-ish card on an A4 page.
 */

export interface ReceiptLogo {
  /** JPEG bytes (the PNG logo drawn on white). */
  jpeg: Uint8Array;
  width: number;
  height: number;
}

export interface ReceiptContent {
  /** "Sales slip" or "Payment advice". */
  title: string;
  amount: string;
  status: string;
  /** "Paid 24 Nov 2026, 11:30:17". */
  subtitle: string;
  rows: [label: string, value: string][];
  note: string;
}

const PAGE_W = 595.28; // A4 points
const PAGE_H = 841.89;

/** Builds the PDF bytes. */
export function buildReceiptPdf(c: ReceiptContent, logo: ReceiptLogo | null): Uint8Array {
  const ops: string[] = [];
  const left = 72;
  let y = PAGE_H - 72;

  // Card outline.
  ops.push('0.89 0.91 0.94 RG 1 w', `${left - 24} ${180} ${PAGE_W - 2 * (left - 24)} ${PAGE_H - 72 - 180 + 24} re S`);

  // Logo (height 28 pt) and status at the top right.
  if (logo) {
    const h = 28;
    const w = (logo.width / logo.height) * h;
    ops.push('q', `${w.toFixed(2)} 0 0 ${h} ${left} ${(y - h).toFixed(2)} cm`, '/Logo Do', 'Q');
  } else {
    ops.push(text('F2', 20, left, y - 22, 'mobi', '0 0.36 0.67'));
  }
  ops.push(text('F2', 11, PAGE_W - left - widthOf(c.status, 11, true), y - 18, c.status, '0.02 0.46 0.28'));
  y -= 64;

  ops.push(text('F2', 9, left, y, c.title.toUpperCase(), '0.36 0.4 0.46'));
  y -= 30;
  ops.push(text('F2', 26, left, y, c.amount, '0.06 0.09 0.16'));
  y -= 20;
  ops.push(text('F1', 11, left, y, c.subtitle, '0.36 0.4 0.46'));
  y -= 24;
  ops.push('0.93 0.95 0.96 RG 1 w', `${left} ${y} m ${PAGE_W - left} ${y} l S`);
  y -= 26;

  for (const [label, value] of c.rows) {
    ops.push(text('F1', 9, left, y, label, '0.36 0.4 0.46'));
    ops.push(text('F2', 11, left + 170, y, value, '0.06 0.09 0.16'));
    y -= 24;
  }
  y -= 6;
  ops.push('0.93 0.95 0.96 RG 1 w', `${left} ${y} m ${PAGE_W - left} ${y} l S`);
  y -= 22;
  for (const line of wrap(c.note, 86)) {
    ops.push(text('F1', 9, left, y, line, '0.36 0.4 0.46'));
    y -= 13;
  }

  const content = ops.join('\n');
  const objects: (string | Uint8Array[])[] = [];
  const add = (o: string | Uint8Array[]) => objects.push(o) && objects.length;
  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >>${logo ? ' /XObject << /Logo 7 0 R >>' : ''} >> >>`);
  add([ascii(`<< /Length ${content.length} >>\nstream\n`), latin(content), ascii('\nendstream')]);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  if (logo) add([ascii(`<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.jpeg.length} >>\nstream\n`), logo.jpeg, ascii('\nendstream')]);

  const parts: Uint8Array[] = [ascii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  let offset = parts[0].length;
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(offset);
    const chunks = [ascii(`${i + 1} 0 obj\n`), ...(typeof o === 'string' ? [ascii(o)] : o), ascii('\nendobj\n')];
    for (const ch of chunks) {
      parts.push(ch);
      offset += ch.length;
    }
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`), `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`].join('');
  parts.push(ascii(xref));

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Draws a PNG/SVG logo on white and returns it as JPEG for the PDF (browser only). */
export async function loadLogoAsJpeg(url: string): Promise<ReceiptLogo | null> {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
    if (!blob) return null;
    return { jpeg: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ helpers

function text(font: 'F1' | 'F2', size: number, x: number, y: number, s: string, rgb: string): string {
  return `BT ${rgb} rg /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escape(s)}) Tj ET`;
}

/** PDF string escaping, then WinAnsi: characters it lacks become "?". */
function escape(s: string): string {
  return toWinAnsi(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

const WIN_ANSI: Record<string, number> = { '•': 0x95, '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '…': 0x85, '€': 0x80 };

function toWinAnsi(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) out += ch;
    else if (WIN_ANSI[ch]) out += String.fromCharCode(WIN_ANSI[ch]);
    else out += '?';
  }
  return out;
}

/** Rough Helvetica width (for right-aligning the status). */
function widthOf(s: string, size: number, bold: boolean): number {
  return s.length * size * (bold ? 0.6 : 0.55);
}

function wrap(s: string, max: number): string[] {
  const words = s.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > max) {
      lines.push(line.trim());
      line = w;
    } else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

function ascii(s: string): Uint8Array {
  return latin(s);
}

/** One byte per character (content is already WinAnsi). */
function latin(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}
