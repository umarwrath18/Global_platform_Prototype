import { DocumentAccess, DocumentRecord, HistoryEvent, StaffRole } from '../merchants/merchant-models';
import { ONBOARDING_COUNTRIES } from '../merchants/onboarding-config';
import type { MerchantDb } from './merchant-server';
import { fail } from './server-errors';

/** Teams that may open and download an application's documents. */
export const DOCUMENT_VIEWER_ROLES: readonly StaffRole[] = ['sales', 'risk', 'cs'];

/** Opening the same file again straight after, within this window, updates the entry instead of adding one. */
const VIEW_DEDUPE_MS = 10 * 60_000;

/**
 * Sets who uploaded each file. A file already known (same id) keeps its uploader; a new one is the
 * caller's. The browser never decides this.
 */
export function stampUploads(known: DocumentRecord[], next: DocumentRecord[], by: string, role: StaffRole): DocumentRecord[] {
  const byId = new Map(known.map((d) => [d.id, d]));
  return next.map((d) => {
    const { uploadedBy: _b, uploadedByRole: _r, ...rest } = d;
    if (d.sample) return rest;
    const prev = byId.get(d.id);
    if (prev) return prev.uploadedBy ? { ...rest, uploadedBy: prev.uploadedBy, uploadedByRole: prev.uploadedByRole } : rest;
    return { ...rest, uploadedBy: by, uploadedByRole: role };
  });
}

/**
 * Records that someone opened or downloaded one of an application's documents: a current file, or
 * one proposed in a change request for that application. Sales / Operations, Risk and CS only.
 */
export function recordDocumentAccess(db: MerchantDb, applicationId: string, docId: string, body: any, who: { name: string; role: StaffRole }, now: number): HistoryEvent[] {
  if (!DOCUMENT_VIEWER_ROLES.includes(who.role)) fail(403, 'ROLE_NOT_PERMITTED', { message: 'Only Sales / Operations, Risk and CS can open application documents.' });
  const action: DocumentAccess = body?.action === 'download' ? 'download' : body?.action === 'view' ? 'view' : fail(400, 'VALIDATION_FAILED', { message: 'Choose view or download.' });
  const app = db.applications.find((a) => a.id === applicationId) ?? fail(404, 'NOT_FOUND', { message: `No application ${applicationId}.` });
  const proposed = (db.changeRequests ?? []).filter((r) => r.applicationId === app.id && r.section === 'documents').flatMap((r) => [...((r.proposed as DocumentRecord[]) ?? []), ...(r.previousDocuments ?? [])]);
  const doc = [...app.data.documents, ...proposed].find((d) => d.id === docId) ?? fail(404, 'NOT_FOUND', { message: 'That document is not on this application.' });
  if (action === 'download' && doc.sample) fail(409, 'INVALID_TRANSITION', { message: 'No file to download for demo records.' });

  const label = ONBOARDING_COUNTRIES[app.country]?.documents.find((r) => r.type === doc.type)?.label ?? doc.type;
  const title = action === 'view' ? 'Viewed document' : 'Downloaded document';
  const comment = `${label} · ${doc.fileName}`;
  // Only the latest entry is merged, so the history stays in time order.
  const last = app.history.at(-1);
  if (action === 'view' && last && last.action === title && last.by === who.name && last.role === who.role && last.comment === comment && now - last.at < VIEW_DEDUPE_MS) last.at = now;
  else app.history.push({ at: now, action: title, by: who.name, role: who.role, fromStatus: null, toStatus: null, comment });
  return app.history;
}
