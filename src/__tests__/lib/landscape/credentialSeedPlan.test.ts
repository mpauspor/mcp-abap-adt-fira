/**
 * The rule that decides whether a session file needs the credential store
 * before a session store can be built (T-013).
 *
 * `EnvFileSessionStore` reads the file itself and returns null for basic auth
 * when `SAP_PASSWORD` is absent, so the broker was never created and the server
 * fell back to a mock connection whose config has no client — surfacing, far
 * away, as "Basic authentication requires SAP_CLIENT to be provided". The plan
 * below is what tells the factory to resolve the credential and seed the store
 * instead, and the auth type has to be derived the same way the env store
 * derives it or the two disagree about what the file means.
 */

import { planCredentialSeed } from '../../../lib/landscape/passwordResolver';

const base = {
  SAP_URL: 'https://example.invalid:44300',
  SAP_CLIENT: '100',
  SAP_USERNAME: 'TESTUSER',
};

describe('planCredentialSeed', () => {
  it('asks for the credential store when a basic file has a target and no password', () => {
    expect(
      planCredentialSeed({
        ...base,
        SAP_AUTH_TYPE: 'basic',
        SAP_CREDENTIAL_TARGET: 'mcp-abap-adt:dev',
      }),
    ).toEqual({ authType: 'basic', needsCredentialStore: true });
  });

  it('leaves a file that carries its own password alone', () => {
    // The existing definitions still work exactly as before (D-007).
    expect(
      planCredentialSeed({
        ...base,
        SAP_AUTH_TYPE: 'basic',
        SAP_PASSWORD: 'in-the-file',
        SAP_CREDENTIAL_TARGET: 'mcp-abap-adt:dev',
      }).needsCredentialStore,
    ).toBe(false);
  });

  it('treats a blank password as no password', () => {
    expect(
      planCredentialSeed({
        ...base,
        SAP_PASSWORD: '   ',
        SAP_CREDENTIAL_TARGET: 'mcp-abap-adt:dev',
      }).needsCredentialStore,
    ).toBe(true);
  });

  it('ignores a blank target', () => {
    expect(
      planCredentialSeed({
        ...base,
        SAP_CREDENTIAL_TARGET: '   ',
      }).needsCredentialStore,
    ).toBe(false);
  });

  it('defaults to basic when the file does not say', () => {
    expect(planCredentialSeed(base).authType).toBe('basic');
  });

  it('reads a JWT token as JWT, whatever SAP_AUTH_TYPE says', () => {
    // Same precedence as EnvFileSessionStore: the token wins. A JWT file never
    // needs the credential store, even if it also names a target.
    const plan = planCredentialSeed({
      ...base,
      SAP_AUTH_TYPE: 'basic',
      SAP_JWT_TOKEN: 'a.b.c',
      SAP_CREDENTIAL_TARGET: 'mcp-abap-adt:dev',
    });
    expect(plan).toEqual({ authType: 'jwt', needsCredentialStore: false });
  });

  it('accepts SAP_AUTH_TYPE in any case and with spaces', () => {
    expect(
      planCredentialSeed({ ...base, SAP_AUTH_TYPE: '  JWT  ' }).authType,
    ).toBe('jwt');
  });

  it('does not ask for the credential store for a JWT file', () => {
    expect(
      planCredentialSeed({ ...base, SAP_AUTH_TYPE: 'jwt' })
        .needsCredentialStore,
    ).toBe(false);
  });
});
