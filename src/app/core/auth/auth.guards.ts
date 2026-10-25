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

/** Only allow in-app paths as post-login redirects (prevents open redirects). */
export function safeReturnUrl(url: string | null | undefined): string | null {
  if (!url || !url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return null;
  return url;
}
