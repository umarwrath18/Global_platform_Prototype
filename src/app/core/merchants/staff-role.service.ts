import { Injectable, computed, signal } from '@angular/core';
import { SecurityRole } from '../api/models';
import { StaffRole } from './merchant-models';

const ROLE_KEY = 'mobi.gp.demoActingRole';
const SECURITY_ROLE_KEY = 'mobi.gp.demoSecurityRole';

export type ActingRole = StaffRole | SecurityRole;

export const SECURITY_ROLE_LABEL: Record<SecurityRole, string> = {
  support: 'Mobi Support',
  security: 'Security Admin (Tech)',
};

/**
 * PROTOTYPE ONLY. Lets a tester act as Sales/Ops, Risk, CS, FinOps, Mobi Support or Security
 * Admin without separate logins. The role is sent to the simulated backend, which enforces it.
 * In production the role comes from the signed-in user's permissions and this control is removed.
 *
 * Merchant pages read `role()` (a merchant team). Support and Security Admin are kept apart in
 * `securityRole()` and only unlock the User security page; they grant no merchant permissions.
 */
@Injectable({ providedIn: 'root' })
export class StaffRoleService {
  private readonly state = signal<StaffRole>(this.read());
  private readonly securityState = signal<SecurityRole | null>(this.readSecurity());
  readonly role = this.state.asReadonly();
  readonly securityRole = this.securityState.asReadonly();
  /** What the "View as" switcher shows. */
  readonly acting = computed<ActingRole>(() => this.securityState() ?? this.state());

  set(role: ActingRole) {
    if (role === 'support' || role === 'security') {
      this.securityState.set(role);
    } else {
      this.securityState.set(null);
      this.state.set(role);
    }
    try {
      localStorage.setItem(ROLE_KEY, this.state());
      const s = this.securityState();
      if (s) localStorage.setItem(SECURITY_ROLE_KEY, s);
      else localStorage.removeItem(SECURITY_ROLE_KEY);
    } catch {
      // The role still applies for this page load.
    }
  }

  private read(): StaffRole {
    try {
      const v = localStorage.getItem(ROLE_KEY);
      return v === 'risk' || v === 'cs' || v === 'finops' ? v : 'sales';
    } catch {
      return 'sales';
    }
  }

  private readSecurity(): SecurityRole | null {
    try {
      const v = localStorage.getItem(SECURITY_ROLE_KEY);
      return v === 'support' || v === 'security' ? v : null;
    } catch {
      return null;
    }
  }
}
