import { Injectable, computed, inject, signal } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { SecurityRole } from '../api/models';
import { StaffRole } from './merchant-models';

const ROLE_KEY = 'mobi.gp.demoActingRole';
const SECURITY_ROLE_KEY = 'mobi.gp.demoSecurityRole';

/** Tech Ops manages hosts (Host Management); like Support and Security, it has no merchant permissions. */
export type TechRole = 'techops';
export type ActingRole = StaffRole | SecurityRole | TechRole;

export const TECH_ROLE_LABEL: Record<TechRole, string> = { techops: 'Tech Ops' };

export const SECURITY_ROLE_LABEL: Record<SecurityRole, string> = {
  support: 'Mobi Support',
  security: 'Security Admin (Tech)',
};

/**
 * The team the signed-in user acts as. Each login has a fixed team (from the server) that the
 * backend enforces; only the prototype admin login may switch with "View as" (PROTOTYPE ONLY –
 * in production the team comes from the user's permissions and the switcher is removed).
 *
 * Merchant pages read `role()` (a merchant team). Support and Security Admin are kept apart in
 * `securityRole()` and only unlock the User security page; they grant no merchant permissions.
 */
@Injectable({ providedIn: 'root' })
export class StaffRoleService {
  private readonly auth = inject(AuthService);
  private readonly state = signal<StaffRole>(this.read());
  private readonly securityState = signal<SecurityRole | TechRole | null>(this.readSecurity());
  /** The login's own team; null for merchant users or before sign-in. */
  readonly team = computed(() => this.auth.session()?.team ?? null);
  /** Only the prototype admin login may switch teams. */
  readonly canSwitch = computed(() => this.team() === 'admin');
  readonly role = computed<StaffRole>(() => {
    const t = this.team();
    return t === 'sales' || t === 'risk' || t === 'cs' || t === 'finops' ? t : this.state();
  });
  readonly securityRole = computed<SecurityRole | null>(() => {
    const t = this.team();
    if (t === 'support' || t === 'security') return t;
    const s = t === 'admin' || t === null ? this.securityState() : null;
    return s === 'support' || s === 'security' ? s : null;
  });
  /** True when acting as Tech Ops (the Tech Ops login, or the prototype admin viewing as it). */
  readonly techOps = computed(() => {
    const t = this.team();
    return t === 'techops' || ((t === 'admin' || t === null) && this.securityState() === 'techops');
  });
  /** What the "View as" switcher (or the fixed team label) shows. */
  readonly acting = computed<ActingRole>(() => this.securityRole() ?? (this.techOps() ? 'techops' : this.role()));

  set(role: ActingRole) {
    if (!this.canSwitch()) return;
    if (role === 'support' || role === 'security' || role === 'techops') {
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

  private readSecurity(): SecurityRole | TechRole | null {
    try {
      const v = localStorage.getItem(SECURITY_ROLE_KEY);
      return v === 'support' || v === 'security' || v === 'techops' ? v : null;
    } catch {
      return null;
    }
  }
}
