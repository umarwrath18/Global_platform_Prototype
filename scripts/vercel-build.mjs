// Builds one of the two apps for Vercel, chosen by the PORTAL environment variable:
//   PORTAL=internal (default) → Mobi Global Platform
//   PORTAL=merchant           → Mobi Merchant Portal
// Each Vercel project sets PORTAL in Settings → Environment Variables. The chosen build is
// copied to dist/vercel, the single output directory vercel.json points to.
import { execSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';

const portal = (process.env.PORTAL ?? 'internal').trim().toLowerCase();
const project = { internal: 'global-platform', merchant: 'merchant-portal' }[portal];
if (!project) {
  console.error(`Unknown PORTAL "${portal}". Use "internal" or "merchant".`);
  process.exit(1);
}
// HOLD (12 Nov 2026): the Merchant Portal's production link is shared with others, so production
// builds of it stay on the current version until the release is approved. vercel.json's
// ignoreCommand skips them; this guard is the fallback: a failed production build leaves the live
// version in place. Preview (branch) builds still run. Release: remove this block, or set
// MERCHANT_RELEASE=true on the Merchant Portal Vercel project.
const production = process.env.VERCEL_ENV === 'production' || process.env.VERCEL_GIT_COMMIT_REF === 'main';
if (portal === 'merchant' && production && process.env.MERCHANT_RELEASE !== 'true') {
  console.error('Merchant Portal production deploys are on hold: the live version stays as it is. Set MERCHANT_RELEASE=true (or remove this hold) to release.');
  process.exit(1);
}
console.log(`Building ${project} (PORTAL=${portal})`);
execSync(`npx ng build ${project}`, { stdio: 'inherit' });
rmSync('dist/vercel', { recursive: true, force: true });
cpSync(`dist/${project}/browser`, 'dist/vercel', { recursive: true });
console.log(`Copied dist/${project}/browser → dist/vercel`);
