import { Injectable, signal } from '@angular/core';
import { StaffRole } from './merchant-models';

const ROLE_KEY = 'mobi.gp.demoActingRole';

/**
 * PROTOTYPE ONLY. Lets a tester act as Sales/Ops, Risk or CS without separate logins.
 * The role is sent to the simulated backend, which enforces it. In production the role
 * comes from the signed-in user's permissions and this control is removed.
 */
@Injectable({ providedIn: 'root' })
export class StaffRoleService {
  private readonly state = signal<StaffRole>(this.read());
  readonly role = this.state.asReadonly();

  set(role: StaffRole) {
    this.state.set(role);
    try {
      localStorage.setItem(ROLE_KEY, role);
    } catch {
      // The role still applies for this page load.
    }
  }

  private read(): StaffRole {
    try {
      const v = localStorage.getItem(ROLE_KEY);
      return v === 'risk' || v === 'cs' ? v : 'sales';
    } catch {
      return 'sales';
    }
  }
}
