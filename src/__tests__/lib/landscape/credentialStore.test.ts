import { spawnSync } from 'node:child_process';
import {
  checkCredentialTarget,
  clearCredentialCache,
  readCredentialTarget,
} from '../../../lib/landscape/credentialStore';
import { resolveBasicPassword } from '../../../lib/landscape/passwordResolver';

jest.mock('node:child_process', () => ({
  spawnSync: jest.fn(),
}));

describe('credentialStore & passwordResolver', () => {
  const originalPlatform = process.platform;
  const mockedSpawnSync = spawnSync as unknown as jest.Mock;

  beforeEach(() => {
    clearCredentialCache();
    jest.clearAllMocks();
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  it('rejects invalid target name before spawnSync', () => {
    expect(() => readCredentialTarget('invalid:target')).toThrow(
      /Invalid credential target "invalid:target"/,
    );
    expect(mockedSpawnSync).not.toHaveBeenCalled();

    expect(() =>
      checkCredentialTarget('mcp-abap-adt:INVALID_UPPERCASE'),
    ).toThrow(/Invalid credential target/);
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });

  it('throws actionable message with cmdkey command when target not found (1168)', () => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: Buffer.from(JSON.stringify({ present: false, last_error: 1168 })),
      stderr: Buffer.from(''),
    });

    expect(() => readCredentialTarget('mcp-abap-adt:qas', 'DEVELOPER')).toThrow(
      /Credential mcp-abap-adt:qas not found in Windows Credential Manager\. Create it with: cmdkey \/generic:mcp-abap-adt:qas \/user:DEVELOPER \/pass/,
    );
  });

  it('throws when stored username does not match SAP_USERNAME', () => {
    const rawSecret = Buffer.from('Secret123!', 'utf16le').toString('base64');
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: Buffer.from(
        JSON.stringify({
          present: true,
          user: 'DIFFERENT_USER',
          secret_b64: rawSecret,
        }),
      ),
      stderr: Buffer.from(''),
    });

    expect(() =>
      resolveBasicPassword({
        SAP_CREDENTIAL_TARGET: 'mcp-abap-adt:qas',
        SAP_USERNAME: 'EXPECTED_USER',
      }),
    ).toThrow(
      /Stored username in credential "mcp-abap-adt:qas" \(DIFFERENT_USER\) does not match SAP_USERNAME \(EXPECTED_USER\)/,
    );
  });

  it('returns secret decoded as UTF-16LE when valid entry found', () => {
    const secretText = 'Pá$$w0rd-ñ-€';
    const rawSecret = Buffer.from(secretText, 'utf16le').toString('base64');
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: Buffer.from(
        JSON.stringify({
          present: true,
          user: 'SAP_USER',
          secret_b64: rawSecret,
        }),
      ),
      stderr: Buffer.from(''),
    });

    const result = readCredentialTarget('mcp-abap-adt:qas');
    expect(result.user).toBe('SAP_USER');
    expect(result.secret).toBe(secretText);
  });

  it('throws actionable IT message on Constrained Language Mode error', () => {
    mockedSpawnSync.mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from(
        'Cannot add type. Compilation errors occurred. ConstrainedLanguage mode',
      ),
    });

    expect(() => readCredentialTarget('mcp-abap-adt:qas')).toThrow(
      /Windows Credential Manager is not usable here: PowerShell Add-Type is blocked \(Constrained Language Mode\)/,
    );
  });

  it('hits cache on second call and does not invoke spawnSync again', () => {
    const secretText = 'Secret123!';
    const rawSecret = Buffer.from(secretText, 'utf16le').toString('base64');
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: Buffer.from(
        JSON.stringify({
          present: true,
          user: 'SAP_USER',
          secret_b64: rawSecret,
        }),
      ),
      stderr: Buffer.from(''),
    });

    const first = readCredentialTarget('mcp-abap-adt:cached');
    expect(first.secret).toBe(secretText);
    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);

    const second = readCredentialTarget('mcp-abap-adt:cached');
    expect(second.secret).toBe(secretText);
    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('throws actionable error when on non-Windows platform', () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });

    expect(() => readCredentialTarget('mcp-abap-adt:qas')).toThrow(
      /SAP_CREDENTIAL_TARGET is set but no credential store is available on linux\./,
    );
  });

  it('resolveBasicPassword prefers SAP_PASSWORD over SAP_CREDENTIAL_TARGET', () => {
    const res = resolveBasicPassword({
      SAP_PASSWORD: 'direct_password',
      SAP_CREDENTIAL_TARGET: 'mcp-abap-adt:dev',
    });
    expect(res).toBe('direct_password');
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });
});
