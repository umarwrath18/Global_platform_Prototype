import { AuthServer } from '../auth-server';
import { DEMO_PASSWORD } from '../seed';

/**
 * Test helper: completes the full sign-in (password, then 2FA setup or verification using the
 * prototype's demo authenticator) and returns the session token. Throws if any step fails.
 */
export async function signIn(server: AuthServer, loginId: string, password = DEMO_PASSWORD): Promise<string> {
  const login = await server.handle('POST', '/api/auth/login', { loginId, password }, null);
  if (login.status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(login.body)}`);
  const { challengeToken, stage } = login.body as { challengeToken: string; stage: string };
  const code = async () => (await server.demoAuthenticator('challenge', challengeToken))!.code;

  let res;
  if (stage === 'setup') {
    await server.handle('POST', '/api/auth/mfa/setup', { challengeToken }, null);
    res = await server.handle('POST', '/api/auth/mfa/setup/verify', { challengeToken, code: await code() }, null);
  } else {
    res = await server.handle('POST', '/api/auth/mfa/verify', { challengeToken, code: await code() }, null);
  }
  if (res.status !== 200) throw new Error(`2FA failed: ${JSON.stringify(res.body)}`);
  return (res.body as { token: string }).token;
}

/** Test helper: the current code from the signed-in user's demo authenticator (for re-authentication). */
export async function currentCode(server: AuthServer, token: string): Promise<string> {
  return (await server.demoAuthenticator('session', token))!.code;
}
