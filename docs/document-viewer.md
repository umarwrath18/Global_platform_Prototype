# Viewing uploaded documents (November 2026)

Risk, Sales / Operations and CS can open the documents attached to a country application, and Risk
sees the current and proposed file side by side when Sales / Operations asks to change a document.
Design approved on 24 Nov 2026. View only: marking documents (accepted, needs a new file) comes later.

## Decisions
| Topic | Decision |
|---|---|
| Who can open | **Sales / Operations, Risk and CS**. FinOps sees the file names without links. The server checks the team again on every open and download. |
| Where | Application page → **Application** → Documents: each file name opens the **Document** side sheet. In a documents change request, the **Current** and **Proposed** files open the same sheet. |
| Document sheet | Preview (PDF in the browser's own viewer; JPG / PNG inline with zoom), then **Document type · File name · Size · Uploaded by · Uploaded**, and **Open in new tab** / **Download**. Note: "Opening and downloading are recorded in the application history." |
| Audit | Opening a document adds **Viewed document** and a download adds **Downloaded document** to the application's Activity (who, team, when, document type and file name). Opening the same file again straight after, within 10 minutes, updates that entry instead of adding another. |
| Uploaded by | Set by the server when a file first appears (draft save, submission or change request), never by the browser. A file approved through a change request keeps the person who uploaded it. |
| Files | PDF, JPG or PNG, up to **10 MB** (the existing upload rule), one file per document type. |
| Change requests | Documents requests show a card per changed document type: **Current** and **Proposed** (or *None* / *Removed*). Both files stay openable from the request after Risk decides. |
| Demo records | Seeded documents have no file: the sheet shows a **Sample document** page with "This demo record has no file attached. Documents you upload in this browser open here." Download is off ("No file to download for demo records."). |

## Prototype limits
- File contents are stored in **this browser** (IndexedDB), keyed by the document's ID; application data
  holds only the file details. A file uploaded in one browser shows "File not in this browser" in
  another. Two tabs of the same browser share the files.
- A real system keeps files in a document service with access control, virus scanning and retention.

## Code
- Files in the browser: `src/app/core/documents/document-files.ts`.
- Server rules (uploader, access check, history): `src/app/core/mock-server/documents.ts`;
  `POST /api/applications/:id/documents/:docId/access` with `{ action: 'view' | 'download' }`.
- Document sheet: `src/app/features/documents/document-sheet.ts`; the list in
  `application-summary.html`; the side-by-side view in `features/changes/pending-changes.html`.
- Tests: `src/app/core/mock-server/documents.spec.ts`.
