import { Injectable, signal } from '@angular/core';
import type { DemoEmail } from '../core/mock-server/auth-server';

export interface InboxMessage extends DemoEmail {
  id: number;
  receivedAt: number;
}

/** Prototype stand-in for the user's mailbox, so OTP emails can be seen on screen. */
@Injectable({ providedIn: 'root' })
export class DemoInboxService {
  private nextId = 1;
  readonly messages = signal<InboxMessage[]>([]);

  deliver(email: DemoEmail) {
    const msg = { ...email, id: this.nextId++, receivedAt: Date.now() };
    this.messages.update((list) => [msg, ...list].slice(0, 3));
    setTimeout(() => this.dismiss(msg.id), email.expiresInMin * 60_000);
  }

  clear() {
    this.messages.set([]);
  }

  dismiss(id: number) {
    this.messages.update((list) => list.filter((m) => m.id !== id));
  }
}
