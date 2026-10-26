import { readCredentialTarget } from './credentialStore';

/** What a session file asks of the credential store. */
export interface CredentialSeedPlan {
  /** The auth type the file declares, read the way the env store reads it. */
  authType: 'basic' | 'jwt';
  /**
   * True when the file uses basic auth, carries no password of its own, and
   * names a credential target. Only then must a caller resolve the credential
   * and seed the session store: `EnvFileSessionStore` reads the file itself and
   * refuses basic auth without `SAP_PASSWORD` (T-013).
   */
  needsCredentialStore: boolean;
}

/**
 * Decide, from a session file's keys alone, whether the credential store has to
 * be consulted before a session store can be built.
 *
 * Kept separate from `resolveBasicPassword` so the rule can be tested without a
 * credential store, and so the auth type is derived exactly once. `SAP_JWT_TOKEN`
 * wins over `SAP_AUTH_TYPE`, matching `EnvFileSessionStore`.
 */
export function planCredentialSeed(
  env: Record<string, string | undefined>,
): CredentialSeedPlan {
  const authType: 'basic' | 'jwt' = env.SAP_JWT_TOKEN?.trim()
    ? 'jwt'
    : (env.SAP_AUTH_TYPE ?? 'basic').trim().toLowerCase() === 'jwt'
      ? 'jwt'
      : 'basic';

  return {
    authType,
    needsCredentialStore:
      authType === 'basic' &&
      !env.SAP_PASSWORD?.trim() &&
      !!env.SAP_CREDENTIAL_TARGET?.trim(),
  };
}

/**
 * Resolves the password for basic auth from an environment dictionary or process.env.
 *
 * Precedence:
 * 1. env.SAP_PASSWORD non-empty -> return it as-is.
 * 2. env.SAP_CREDENTIAL_TARGET set -> read from Windows Credential Manager.
 *    Verifies that the stored user matches env.SAP_USERNAME (if present).
 * 3. Otherwise returns undefined (callers retain their existing missing password errors).
 */
export function resolveBasicPassword(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.SAP_PASSWORD && env.SAP_PASSWORD.trim().length > 0) {
    return env.SAP_PASSWORD;
  }

  const target = env.SAP_CREDENTIAL_TARGET?.trim();
  if (target) {
    const username = env.SAP_USERNAME?.trim();
    const cred = readCredentialTarget(target, username);
    if (
      username &&
      cred.user &&
      cred.user.toLowerCase() !== username.toLowerCase()
    ) {
      throw new Error(
        `Stored username in credential "${target}" (${cred.user}) does not match SAP_USERNAME (${username}).`,
      );
    }
    return cred.secret;
  }

  return undefined;
}
