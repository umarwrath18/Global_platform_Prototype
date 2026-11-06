import { InjectionToken } from '@angular/core';

/**
 * Which app the shared sign-in screens are running in. The internal Global Platform and the
 * Mobi Merchant Portal are separate apps (separate URLs) built from this repository; each
 * provides its own value. Only users of the matching kind can sign in to an app.
 */
export interface AppPortal {
  portal: 'internal' | 'merchant';
  /** Shown on sign-in screens, e.g. "Sign in to Global Platform". */
  productName: string;
  /** The other app's name, for "use the other portal" messages. */
  otherProductName: string;
}

export const INTERNAL_PORTAL: AppPortal = { portal: 'internal', productName: 'Global Platform', otherProductName: 'Mobi Merchant Portal' };
export const MERCHANT_PORTAL: AppPortal = { portal: 'merchant', productName: 'Merchant Portal', otherProductName: 'Mobi Global Platform' };

export const APP_PORTAL = new InjectionToken<AppPortal>('APP_PORTAL', { providedIn: 'root', factory: () => INTERNAL_PORTAL });
