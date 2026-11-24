import { Injectable } from '@angular/core';

const DB_NAME = 'mobi-gp-documents';
const STORE = 'files';

/**
 * The uploaded files themselves, kept in this browser (IndexedDB) for the prototype. Application data
 * holds only the file details; a real system stores files in a document service. Falls back to memory
 * when IndexedDB isn't available (private windows, tests), so a file then lasts until the tab closes.
 */
@Injectable({ providedIn: 'root' })
export class DocumentFiles {
  private readonly memory = new Map<string, Blob>();
  private db: Promise<IDBDatabase | null> | null = null;

  async put(id: string, file: Blob): Promise<void> {
    this.memory.set(id, file);
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(file, id);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => resolve(); // the memory copy still works
    });
  }

  async get(id: string): Promise<Blob | null> {
    const hit = this.memory.get(id);
    if (hit) return hit;
    const db = await this.open();
    if (!db) return null;
    return new Promise<Blob | null>((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result instanceof Blob ? req.result : null);
      req.onerror = () => resolve(null);
    });
  }

  private open(): Promise<IDBDatabase | null> {
    this.db ??= new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.db;
  }
}

/** Kind of preview for a file name: PDF in the browser's viewer, images inline. */
export function previewKind(fileName: string): 'pdf' | 'image' | 'other' {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'pdf' ? 'pdf' : ext === 'jpg' || ext === 'jpeg' || ext === 'png' ? 'image' : 'other';
}

export function fileTypeLabel(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'jpeg' ? 'JPG' : ext.toUpperCase();
}

export function fileSizeLabel(sizeKb: number): string {
  return sizeKb >= 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb} KB`;
}
