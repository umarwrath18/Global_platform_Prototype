import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/** UI convenience only: every protected API also validates the session on the server. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.restore();
  if (auth.isAuthenticated()) return true;
  return router.createUrlTree(['/login'], { queryParams: { reason: 'signin-required', returnUrl: state.url } });
};

export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.restore();
  const session = auth.session();
  return session ? router.parseUrl(session.landingPath) : true;
};

/**
 * Keeps each kind of user in their own portal: merchant users only reach the Merchant Portal,
 * internal users never do. UI convenience only; every API also checks this on the server.
 */
export const portalGuard =
  (portal: 'internal' | 'merchant'): CanActivateFn =>
  async () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    await auth.restore();
    const session = auth.session();
    if (!session) return router.createUrlTree(['/login'], { queryParams: { reason: 'signin-required' } });
    return session.portal === portal ? true : router.parseUrl(session.landingPath);
  };

/** The 2FA step is only reachable after a correct password, and never once signed in. */
export const twoFactorGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.restore();
  const session = auth.session();
  if (session) return router.parseUrl(session.landingPath);
  return auth.pending() ? true : router.createUrlTree(['/login']);
};

/** Only allow in-app paths as post-login redirects (prevents open redirects). */
export function safeReturnUrl(url: string | null | undefined): string | null {
  if (!url || !url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return null;
  return url;
}
