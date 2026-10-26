import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hydrateSystemContextFromEnvFile } from '../../../server/envHydration';

describe('launcherHydration', () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydration-test-'));
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('hydrates SAP_LANGUAGE, TLS_REJECT_UNAUTHORIZED, and SAP_CREDENTIAL_TARGET when not in process.env', () => {
    delete process.env.SAP_LANGUAGE;
    delete process.env.TLS_REJECT_UNAUTHORIZED;
    delete process.env.SAP_CREDENTIAL_TARGET;

    const envContent = `
SAP_LANGUAGE=de
TLS_REJECT_UNAUTHORIZED=0
SAP_CREDENTIAL_TARGET=mcp-abap-adt:test
`;
    const envFile = path.join(tempDir, 'test.env');
    fs.writeFileSync(envFile, envContent, 'utf8');

    hydrateSystemContextFromEnvFile(envFile);

    expect(process.env.SAP_LANGUAGE).toBe('de');
    expect(process.env.TLS_REJECT_UNAUTHORIZED).toBe('0');
    expect(process.env.SAP_CREDENTIAL_TARGET).toBe('mcp-abap-adt:test');
  });

  it('does not overwrite existing process.env values', () => {
    process.env.SAP_LANGUAGE = 'es';
    process.env.TLS_REJECT_UNAUTHORIZED = '1';

    const envContent = `
SAP_LANGUAGE=en
TLS_REJECT_UNAUTHORIZED=0
`;
    const envFile = path.join(tempDir, 'test.env');
    fs.writeFileSync(envFile, envContent, 'utf8');

    hydrateSystemContextFromEnvFile(envFile);

    expect(process.env.SAP_LANGUAGE).toBe('es');
    expect(process.env.TLS_REJECT_UNAUTHORIZED).toBe('1');
  });

  it('NEVER copies SAP_PASSWORD to process.env', () => {
    delete process.env.SAP_PASSWORD;

    const envContent = `
SAP_PASSWORD=ShouldNeverEnterProcessEnv!
SAP_MASTER_SYSTEM=DEV
`;
    const envFile = path.join(tempDir, 'test.env');
    fs.writeFileSync(envFile, envContent, 'utf8');

    hydrateSystemContextFromEnvFile(envFile);

    expect(process.env.SAP_PASSWORD).toBeUndefined();
    expect(process.env.SAP_MASTER_SYSTEM).toBe('DEV');
  });
});
