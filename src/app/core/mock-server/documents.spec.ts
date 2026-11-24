import { beforeEach, describe, expect, it } from 'vitest';
import { ChangeRequest } from '../merchants/change-requests';
import { DocumentRecord, HistoryEvent, StaffRole } from '../merchants/merchant-models';
import { ONBOARDING_COUNTRIES } from '../merchants/onboarding-config';
import { AuthServer } from './auth-server';
import { stampUploads } from './documents';
import { MerchantDb, MerchantServer } from './merchant-server';
import { FlakyStorage } from './testing/merchant-test-data';
import { signIn } from './testing/sign-in';

const KEY = 'mobi.gp.merchantdb';

// APP-2026-0009 (Indonesia) is past Risk approval; APP-2026-0014 (Vietnam) is a draft. Seeded files are samples.
describe('Application documents', () => {
  let now: number;
  let storage: FlakyStorage;
  let auth: AuthServer;
  let server: MerchantServer;
  let token: string;

  const call = <T = any>(method: string, path: string, body: unknown = null, role: StaffRole = 'sales') => server.handle(method, path, body, token, role) as Promise<{ status: number; body: T }>;
  const access = (appId: string, docId: string, action: string, role: StaffRole = 'risk') => call<{ history: HistoryEvent[] }>('POST', `/api/applications/${appId}/documents/${docId}/access`, { action }, role);
  const db = () => JSON.parse(storage.getItem(KEY)!) as MerchantDb;
  const app = (id: string) => db().applications.find((a) => a.id === id)!;
  const file = (type: string, id: string, fileName: string, extra: Partial<DocumentRecord> = {}): DocumentRecord => ({ id, type, fileName, sizeKb: 220, uploadedAt: now, sample: false, ...extra });

  beforeEach(async () => {
    now = Date.UTC(2026, 10, 24, 9);
    storage = new FlakyStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {} });
    server = new MerchantServer({ storage, now: () => now, auth });
    token = await signIn(auth, '123'); // Sarah Lim
    await call('GET', '/api/merchants');
  });

  it('records who opened or downloaded a file; Sales / Operations, Risk and CS only', async () => {
    const doc = app('APP-2026-0009').data.documents[0];
    expect(doc.sample).toBe(true);

    expect(await access('APP-2026-0009', doc.id, 'view', 'finops')).toMatchObject({ status: 403, body: { code: 'ROLE_NOT_PERMITTED' } });
    expect((await access('APP-2026-0009', 'nope', 'view')).status).toBe(404);
    expect((await access('APP-2026-0009', doc.id, 'print')).status).toBe(400);

    for (const role of ['sales', 'risk', 'cs'] as StaffRole[]) expect((await access('APP-2026-0009', doc.id, 'view', role)).status).toBe(200);
    const last = app('APP-2026-0009').history.at(-1)!;
    expect(last).toMatchObject({ action: 'Viewed document', by: 'Sarah Lim', role: 'cs', fromStatus: null, toStatus: null });
    expect(last.comment).toContain(doc.fileName);

    // Opening the same file again within 10 minutes doesn't add another entry.
    const count = app('APP-2026-0009').history.length;
    now += 5 * 60_000;
    await access('APP-2026-0009', doc.id, 'view', 'cs');
    expect(app('APP-2026-0009').history).toHaveLength(count);
    now += 11 * 60_000;
    await access('APP-2026-0009', doc.id, 'view', 'cs');
    expect(app('APP-2026-0009').history).toHaveLength(count + 1);

    // Demo records have no file to download.
    expect((await access('APP-2026-0009', doc.id, 'download')).body).toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('the server sets who uploaded a file; the browser cannot', async () => {
    const draft = app('APP-2026-0014');
    const docType = ONBOARDING_COUNTRIES['VN'].documents[0].type;
    const data = { ...draft.data, documents: [...draft.data.documents.filter((d) => d.type !== docType), file(docType, 'up1', 'licence.pdf', { uploadedBy: 'Someone Else', uploadedByRole: 'risk' })] };
    expect((await call('PUT', '/api/applications/APP-2026-0014', { data })).status).toBe(200);
    expect(app('APP-2026-0014').data.documents.find((d) => d.id === 'up1')).toMatchObject({ uploadedBy: 'Sarah Lim', uploadedByRole: 'sales' });

    // Saving again keeps the original uploader.
    await call('PUT', '/api/applications/APP-2026-0014', { data: { ...app('APP-2026-0014').data } });
    expect(app('APP-2026-0014').data.documents.find((d) => d.id === 'up1')?.uploadedBy).toBe('Sarah Lim');
  });

  it('a change request shows current and proposed files, and both stay openable after the decision', async () => {
    const before = app('APP-2026-0009').data.documents;
    const replaced = before[0];
    const proposed = [...before.filter((d) => d.id !== replaced.id), file(replaced.type, 'new1', 'bank-statement-q3.pdf')];
    const res = await call<ChangeRequest>('POST', '/api/applications/APP-2026-0009/changes', { section: 'documents', value: proposed, reason: 'Latest statement from the new settlement account' });
    expect(res.status).toBe(201);
    expect(res.body.previousDocuments?.map((d) => d.id)).toEqual(before.map((d) => d.id));
    expect(res.body.proposedDocuments?.find((d) => d.id === 'new1')).toMatchObject({ fileName: 'bank-statement-q3.pdf', uploadedBy: 'Sarah Lim', uploadedByRole: 'sales' });
    expect(res.body).not.toHaveProperty('proposed');

    // Risk opens and downloads the proposed file before deciding.
    expect((await access('APP-2026-0009', 'new1', 'view')).status).toBe(200);
    expect((await access('APP-2026-0009', 'new1', 'download')).status).toBe(200);
    expect(app('APP-2026-0009').history.at(-1)).toMatchObject({ action: 'Downloaded document', role: 'risk' });

    await call('POST', `/api/changes/${res.body.id}/decision`, { decision: 'approve', comment: '' }, 'risk');
    // The uploader stays Sales / Operations, not the Risk approver.
    expect(app('APP-2026-0009').data.documents.find((d) => d.id === 'new1')).toMatchObject({ uploadedBy: 'Sarah Lim', uploadedByRole: 'sales' });
    // The replaced file is still openable from the request.
    expect((await access('APP-2026-0009', replaced.id, 'view')).status).toBe(200);
  });

  it('stampUploads keeps known uploaders, sets new ones and never stamps samples', () => {
    const known = [file('a', 'k1', 'a.pdf', { uploadedBy: 'Ana', uploadedByRole: 'sales' })];
    const next = [file('a', 'k1', 'a.pdf', { uploadedBy: 'Forged' }), file('b', 'k2', 'b.pdf'), file('c', 'k3', 'c.pdf', { sample: true, uploadedBy: 'X' })];
    const out = stampUploads(known, next, 'Ben', 'cs');
    expect(out[0]).toMatchObject({ uploadedBy: 'Ana', uploadedByRole: 'sales' });
    expect(out[1]).toMatchObject({ uploadedBy: 'Ben', uploadedByRole: 'cs' });
    expect(out[2]).not.toHaveProperty('uploadedBy');
  });
});
