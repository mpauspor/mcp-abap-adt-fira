import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleSetupSystem } from '../../../handlers/multisystem/high/handleSetupSystem';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import * as credentialStore from '../../../lib/landscape/credentialStore';
import * as probeModule from '../../../lib/landscape/probe';
import { unwrap } from '../../integration/helpers/firaContext';

describe('SetupSystem handler', () => {
  let tempDir: string;
  let landscapeFile: string;
  const originalAuthBrokerPath = process.env.AUTH_BROKER_PATH;

  const mockContext: HandlerContext = {
    connection: {} as any,
    logger: {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as any,
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-test-'));
    process.env.AUTH_BROKER_PATH = tempDir;

    landscapeFile = path.join(tempDir, 'landscape.xml');
    const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<Landscape>
  <Workspaces>
    <Workspace name="Local">
      <Node name="Folder">
        <Item serviceid="uuid-unique-sid" />
        <Item serviceid="uuid-dup-1" />
        <Item serviceid="uuid-dup-2" />
      </Node>
    </Workspace>
  </Workspaces>
  <Services>
    <Service uuid="uuid-unique-sid" name="S4 Dev System" systemid="DEV" server="s4dev.corp:3200" type="SAPGUI" />
    <Service uuid="uuid-dup-1" name="Duplicate SID 1" systemid="DUP" server="dup1.corp:3200" type="SAPGUI" />
    <Service uuid="uuid-dup-2" name="Duplicate SID 2" systemid="DUP" server="dup2.corp:3200" type="SAPGUI" />
  </Services>
</Landscape>`;
    fs.writeFileSync(landscapeFile, xmlContent, 'utf8');
  });

  afterEach(() => {
    process.env.AUTH_BROKER_PATH = originalAuthBrokerPath;
    jest.restoreAllMocks();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('validates client format (e.g. 10 instead of 010) and aborts naming the field', async () => {
    const res = await handleSetupSystem(mockContext, {
      service_uuid: 'uuid-unique-sid',
      client: '10',
      username: 'DEVELOPER',
      landscape_path: landscapeFile,
    });

    const { isError, payload } = unwrap(res);
    expect(isError).toBe(true);
    expect(payload).toMatch(/Client must be a 3-digit number/);
  });

  it('aborts with disambiguation error when SID is not unique and name is omitted', async () => {
    const res = await handleSetupSystem(mockContext, {
      service_uuid: 'uuid-dup-1',
      client: '100',
      username: 'DEVELOPER',
      landscape_path: landscapeFile,
    });

    const { isError, payload } = unwrap(res);
    expect(isError).toBe(true);
    expect(payload).toMatch(
      /SID "DUP" appears multiple times in the landscape; pass "name" to tell them apart\./,
    );
  });

  it('happy path writes atomic file, verifies content, and checks credentials', async () => {
    jest.spyOn(probeModule, 'probeSystem').mockResolvedValue({
      reachable: true,
      dns: 'ok',
      tcp: 'open',
      http_status: 401,
      tls: 'trusted',
      icf: 'requires_logon',
      ms: 30,
      error: null,
    });

    jest.spyOn(credentialStore, 'checkCredentialTarget').mockReturnValue({
      present: false,
      error: 1168,
    });

    const res = await handleSetupSystem(mockContext, {
      service_uuid: 'uuid-unique-sid',
      client: '100',
      username: 'DEVELOPER',
      landscape_path: landscapeFile,
    });

    const { isError, payload } = unwrap(res);
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);
    expect(payload.name).toBe('dev');
    expect(payload.url).toBe('https://s4dev.corp:44300');
    expect(payload.verified).toBe(true);
    expect(payload.url_source).toBe('derived');
    expect(payload.credential).toEqual({
      target: 'mcp-abap-adt:dev',
      present: false,
    });
    expect(Array.isArray(payload.next_steps)).toBe(true);
    expect(payload.next_steps[0]).toContain(
      'cmdkey /generic:mcp-abap-adt:dev /user:DEVELOPER /pass',
    );

    // Verify written file
    expect(fs.existsSync(payload.env_path)).toBe(true);
    const content = fs.readFileSync(payload.env_path, 'utf8');
    expect(content).toContain('SAP_URL=https://s4dev.corp:44300');
    expect(content).toContain('SAP_CLIENT=100');
    expect(content).toContain('SAP_USERNAME=DEVELOPER');
    expect(content).toContain('TLS_REJECT_UNAUTHORIZED=1');
    expect(content).not.toContain('SAP_PASSWORD');
  });

  it('aborts and writes nothing when require_reachable is true and probe fails', async () => {
    jest.spyOn(probeModule, 'probeSystem').mockResolvedValue({
      reachable: false,
      dns: 'ok',
      tcp: 'timeout',
      http_status: null,
      tls: null,
      icf: 'unknown',
      ms: 2000,
      error: 'ETIMEDOUT',
    });

    const res = await handleSetupSystem(mockContext, {
      service_uuid: 'uuid-unique-sid',
      client: '100',
      username: 'DEVELOPER',
      require_reachable: true,
      landscape_path: landscapeFile,
    });

    const { isError, payload } = unwrap(res);
    expect(isError).toBe(true);
    expect(payload).toMatch(
      /s4dev\.corp is not reachable \(ETIMEDOUT\)\. Connect the VPN, or drop require_reachable\./,
    );

    const sessionsDir = path.join(tempDir, 'sessions');
    const targetFile = path.join(sessionsDir, 'dev.env');
    expect(fs.existsSync(targetFile)).toBe(false);
  });

  it('writes file, sets TLS_REJECT_UNAUTHORIZED=1 and emits warning when require_reachable is false and probe fails', async () => {
    jest.spyOn(probeModule, 'probeSystem').mockResolvedValue({
      reachable: false,
      dns: 'fail',
      tcp: 'skipped',
      http_status: null,
      tls: null,
      icf: 'unknown',
      ms: 2000,
      error: 'ENOTFOUND',
    });

    jest.spyOn(credentialStore, 'checkCredentialTarget').mockReturnValue({
      present: false,
      error: 1168,
    });

    const res = await handleSetupSystem(mockContext, {
      service_uuid: 'uuid-unique-sid',
      client: '100',
      username: 'DEVELOPER',
      require_reachable: false,
      landscape_path: landscapeFile,
    });

    const { isError, payload } = unwrap(res);
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);
    expect(
      payload.warnings.some((w: string) => w.includes('not reachable')),
    ).toBe(true);

    const content = fs.readFileSync(payload.env_path, 'utf8');
    expect(content).toContain('TLS_REJECT_UNAUTHORIZED=1');
  });

  it('aborts when file exists without overwrite: true', async () => {
    const sessionsDir = path.join(tempDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const existingFile = path.join(sessionsDir, 'dev.env');
    fs.writeFileSync(
      existingFile,
      'SAP_URL=https://old-server:44300\nSAP_PASSWORD=oldpass\n',
      'utf8',
    );

    jest.spyOn(probeModule, 'probeSystem').mockResolvedValue({
      reachable: true,
      dns: 'ok',
      tcp: 'open',
      http_status: 401,
      tls: 'trusted',
      icf: 'requires_logon',
      ms: 30,
      error: null,
    });

    const res = await handleSetupSystem(mockContext, {
      service_uuid: 'uuid-unique-sid',
      client: '100',
      username: 'DEVELOPER',
      overwrite: false,
      landscape_path: landscapeFile,
    });

    const { isError, payload } = unwrap(res);
    expect(isError).toBe(true);
    expect(payload).toMatch(
      /already exists \(points at https:\/\/old-server:44300\)\. Pass overwrite: true to replace it/,
    );
    expect(payload).toMatch(
      /Replacing it drops the stored password; store it with cmdkey first\./,
    );
  });

  it('rejects unexpected properties such as password', async () => {
    const res = await handleSetupSystem(mockContext, {
      service_uuid: 'uuid-unique-sid',
      client: '100',
      username: 'DEVELOPER',
      landscape_path: landscapeFile,
      password: 'forbidden-password',
    } as any);

    const { isError, payload } = unwrap(res);
    expect(isError).toBe(true);
    expect(payload).toMatch(/Unexpected property: password/);
  });

  it('returns url_source: explicit when url parameter is supplied', async () => {
    jest.spyOn(probeModule, 'probeSystem').mockResolvedValue({
      reachable: true,
      dns: 'ok',
      tcp: 'open',
      http_status: 401,
      tls: 'trusted',
      icf: 'requires_logon',
      ms: 30,
      error: null,
    });

    jest.spyOn(credentialStore, 'checkCredentialTarget').mockReturnValue({
      present: true,
    });

    const res = await handleSetupSystem(mockContext, {
      service_uuid: 'uuid-unique-sid',
      client: '100',
      username: 'DEVELOPER',
      name: 'devexplicit',
      url: 'https://explicit-host.corp:44300',
      landscape_path: landscapeFile,
    });

    const { isError, payload } = unwrap(res);
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);
    expect(payload.url_source).toBe('explicit');
    expect(payload.url).toBe('https://explicit-host.corp:44300');
    expect(payload.credential.present).toBe(true);
    expect(payload.hint).toBe(
      'Language and TLS take effect through the launcher; a value in the process environment wins; TLS is process-wide.',
    );
  });

  describe('TLS outcome combinations and warnings (SPEC §3.5 & §3.8)', () => {
    it('untrusted probe without allow_untrusted_tls writes 1 and emits CA warning', async () => {
      jest.spyOn(probeModule, 'probeSystem').mockResolvedValue({
        reachable: true,
        dns: 'ok',
        tcp: 'open',
        http_status: 401,
        tls: 'untrusted',
        icf: 'requires_logon',
        ms: 30,
        error: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      });
      jest.spyOn(credentialStore, 'checkCredentialTarget').mockReturnValue({
        present: false,
      });

      const res = await handleSetupSystem(mockContext, {
        service_uuid: 'uuid-unique-sid',
        client: '100',
        username: 'DEVELOPER',
        name: 'tlsuntrusted',
        landscape_path: landscapeFile,
      });

      const { isError, payload } = unwrap(res);
      expect(isError).toBe(false);
      const content = fs.readFileSync(payload.env_path, 'utf8');
      expect(content).toContain('TLS_REJECT_UNAUTHORIZED=1');
      expect(payload.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            'The certificate of s4dev.corp is not trusted. Connecting will fail until its CA is trusted (Windows certificate store); if it is self-signed on purpose, re-run with allow_untrusted_tls: true to write TLS_REJECT_UNAUTHORIZED=0, which turns verification off for every system this server connects to.',
          ),
        ]),
      );
    });

    it('untrusted probe with allow_untrusted_tls: true writes 0 and emits whole-server warning', async () => {
      jest.spyOn(probeModule, 'probeSystem').mockResolvedValue({
        reachable: true,
        dns: 'ok',
        tcp: 'open',
        http_status: 401,
        tls: 'untrusted',
        icf: 'requires_logon',
        ms: 30,
        error: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      });
      jest.spyOn(credentialStore, 'checkCredentialTarget').mockReturnValue({
        present: false,
      });

      const res = await handleSetupSystem(mockContext, {
        service_uuid: 'uuid-unique-sid',
        client: '100',
        username: 'DEVELOPER',
        name: 'tlsallow',
        allow_untrusted_tls: true,
        landscape_path: landscapeFile,
      });

      const { isError, payload } = unwrap(res);
      expect(isError).toBe(false);
      const content = fs.readFileSync(payload.env_path, 'utf8');
      expect(content).toContain('TLS_REJECT_UNAUTHORIZED=0');
      expect(payload.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            'Target uses an untrusted TLS certificate and allow_untrusted_tls is true. Setting TLS_REJECT_UNAUTHORIZED=0 in session file (turns verification off for the whole server when this session is active).',
          ),
        ]),
      );
    });

    it('unreachable probe writes 1 and emits default TLS warning', async () => {
      jest.spyOn(probeModule, 'probeSystem').mockResolvedValue({
        reachable: false,
        dns: 'fail',
        tcp: 'closed',
        http_status: null,
        tls: null,
        icf: 'unknown',
        ms: 50,
        error: 'getaddrinfo ENOTFOUND s4dev.corp',
      });
      jest.spyOn(credentialStore, 'checkCredentialTarget').mockReturnValue({
        present: false,
      });

      const res = await handleSetupSystem(mockContext, {
        service_uuid: 'uuid-unique-sid',
        client: '100',
        username: 'DEVELOPER',
        name: 'tlsunreach',
        require_reachable: false,
        landscape_path: landscapeFile,
      });

      const { isError, payload } = unwrap(res);
      expect(isError).toBe(false);
      const content = fs.readFileSync(payload.env_path, 'utf8');
      expect(content).toContain('TLS_REJECT_UNAUTHORIZED=1');
      expect(payload.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            'Probe did not reach the TLS step (host unreachable). Defaulting TLS_REJECT_UNAUTHORIZED=1. Relax to 0 if the system uses an untrusted certificate.',
          ),
        ]),
      );
    });
  });

  describe('URL and parameter validation & injection prevention', () => {
    it('rejects user info in URL', async () => {
      const res = await handleSetupSystem(mockContext, {
        service_uuid: 'uuid-unique-sid',
        client: '100',
        username: 'DEVELOPER',
        url: 'https://user:pass@s4dev.corp:44300',
        landscape_path: landscapeFile,
      });
      const { isError, payload } = unwrap(res);
      expect(isError).toBe(true);
      expect(payload).toMatch(/User info is not allowed in URL/);
    });

    it('rejects non-root path in URL', async () => {
      const res = await handleSetupSystem(mockContext, {
        service_uuid: 'uuid-unique-sid',
        client: '100',
        username: 'DEVELOPER',
        url: 'https://s4dev.corp:44300/sap/bc/adt',
        landscape_path: landscapeFile,
      });
      const { isError, payload } = unwrap(res);
      expect(isError).toBe(true);
      expect(payload).toMatch(/URL must not contain a path/);
    });

    it('rejects query string in URL', async () => {
      const res = await handleSetupSystem(mockContext, {
        service_uuid: 'uuid-unique-sid',
        client: '100',
        username: 'DEVELOPER',
        url: 'https://s4dev.corp:44300?foo=bar',
        landscape_path: landscapeFile,
      });
      const { isError, payload } = unwrap(res);
      expect(isError).toBe(true);
      expect(payload).toMatch(/URL must not contain a query string/);
    });

    it('rejects fragment/hash in URL', async () => {
      const res = await handleSetupSystem(mockContext, {
        service_uuid: 'uuid-unique-sid',
        client: '100',
        username: 'DEVELOPER',
        url: 'https://s4dev.corp:44300#heading',
        landscape_path: landscapeFile,
      });
      const { isError, payload } = unwrap(res);
      expect(isError).toBe(true);
      expect(payload).toMatch(/URL must not contain a hash\/fragment/);
    });

    it('rejects control characters and newlines in URL', async () => {
      const res = await handleSetupSystem(mockContext, {
        service_uuid: 'uuid-unique-sid',
        client: '100',
        username: 'DEVELOPER',
        url: 'https://s4dev.corp:44300\r\n',
        landscape_path: landscapeFile,
      });
      const { isError, payload } = unwrap(res);
      expect(isError).toBe(true);
      expect(payload).toMatch(
        /URL must not contain newlines or control characters/,
      );
    });

    it('rejects control characters in username', async () => {
      const res = await handleSetupSystem(mockContext, {
        service_uuid: 'uuid-unique-sid',
        client: '100',
        username: 'DEV\nUSER',
        landscape_path: landscapeFile,
      });
      const { isError, payload } = unwrap(res);
      expect(isError).toBe(true);
      expect(payload).toMatch(
        /Username must be between 1 and 12 characters and contain no control characters or newlines/,
      );
    });

    it('rejects invalid language code', async () => {
      const res = await handleSetupSystem(mockContext, {
        service_uuid: 'uuid-unique-sid',
        client: '100',
        username: 'DEVELOPER',
        language: 'ESP',
        landscape_path: landscapeFile,
      });
      const { isError, payload } = unwrap(res);
      expect(isError).toBe(true);
      expect(payload).toMatch(
        /Language must be a 2-letter lowercase code \(e\.g\. "es", "en"\)/,
      );
    });

    it('rejects invalid system_type', async () => {
      const res = await handleSetupSystem(mockContext, {
        service_uuid: 'uuid-unique-sid',
        client: '100',
        username: 'DEVELOPER',
        system_type: 'invalid' as any,
        landscape_path: landscapeFile,
      });
      const { isError, payload } = unwrap(res);
      expect(isError).toBe(true);
      expect(payload).toMatch(
        /Invalid system_type "invalid"\. Allowed values: onprem, legacy, cloud/,
      );
    });
  });
});
