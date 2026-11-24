import { describe, expect, it } from 'vitest';
import { buildReceiptPdf } from './receipt-pdf';

const decode = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');

describe('receipt PDF', () => {
  const content = { title: 'Sales slip', amount: 'MYR 1,250.00', status: 'Successful', subtitle: 'Paid 24 Nov 2026, 11:30:17', rows: [['Mobi Ref ID', 'MBP1'], ['Payment method', 'Cards · Visa •••• 4242']] as [string, string][], note: 'Fees are not shown (sample).' };

  it('is a valid one-page PDF whose cross-reference offsets point at each object', () => {
    const pdf = decode(buildReceiptPdf(content, { jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 4, height: 2 }));
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf).toContain('/Filter /DCTDecode');
    const startxref = Number(pdf.match(/startxref\n(\d+)/)![1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe('xref');
    const offsets = [...pdf.slice(startxref).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(pdf.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });

  it('writes the text in WinAnsi, escapes brackets, and never includes a fee', () => {
    const pdf = decode(buildReceiptPdf({ ...content, rows: [['Customer', 'Tan (HQ)']] }, null));
    expect(pdf).toContain('(Tan \\(HQ\\)) Tj');
    expect(pdf).toContain('(MYR 1,250.00) Tj');
    const bullets = decode(buildReceiptPdf(content, null));
    expect(bullets).toContain('Visa \x95\x95\x95\x95 4242');
    expect(bullets).not.toMatch(/Fee \(MDR\)/);
  });
});
