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
console.log(`Building ${project} (PORTAL=${portal})`);
execSync(`npx ng build ${project}`, { stdio: 'inherit' });
rmSync('dist/vercel', { recursive: true, force: true });
cpSync(`dist/${project}/browser`, 'dist/vercel', { recursive: true });
console.log(`Copied dist/${project}/browser → dist/vercel`);
