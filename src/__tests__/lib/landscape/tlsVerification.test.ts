import * as tls from 'node:tls';
import {
  return_error,
  TLS_CERT_ERROR_CODES,
  TLS_CERT_HINT,
} from '../../../lib/utils';
import {
  configureTlsVerification,
  hydrateAndConfigureTls,
} from '../../../server/envHydration';

describe('TLS Verification Configuration (SPEC §3.8, D-009)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TLS_REJECT_UNAUTHORIZED;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('Effective Mode Table', () => {
    it('Row 1: NODE unset, TLS unset -> sets TLS_REJECT_UNAUTHORIZED=1, effectiveMode=on (default)', () => {
      const res = configureTlsVerification();
      expect(res.effectiveMode).toBe('on');
      expect(process.env.TLS_REJECT_UNAUTHORIZED).toBe('1');
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
      expect(res.logLine).toMatch(
        /TLS certificate verification: on \(default;/,
      );
    });

    it('Row 2: NODE unset, TLS=1 -> effectiveMode=on', () => {
      process.env.TLS_REJECT_UNAUTHORIZED = '1';
      const res = configureTlsVerification();
      expect(res.effectiveMode).toBe('on');
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    });

    it('Row 3: NODE unset, TLS=0 -> effectiveMode=off (explicit opt-out)', () => {
      process.env.TLS_REJECT_UNAUTHORIZED = '0';
      const res = configureTlsVerification({ envFileUsed: true });
      expect(res.effectiveMode).toBe('off');
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
      expect(res.logLine).toBe(
        'TLS certificate verification: off (TLS_REJECT_UNAUTHORIZED=0 from session file)',
      );
    });

    it('Row 4: NODE=0, TLS=any -> effectiveMode=off', () => {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      process.env.TLS_REJECT_UNAUTHORIZED = '1';
      const res = configureTlsVerification();
      expect(res.effectiveMode).toBe('off');
      expect(res.logLine).toBe(
        'TLS certificate verification: off (NODE_TLS_REJECT_UNAUTHORIZED=0 in environment)',
      );
    });

    it('Row 5: NODE=1, TLS=0 -> effectiveMode=on', () => {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
      process.env.TLS_REJECT_UNAUTHORIZED = '0';
      const res = configureTlsVerification();
      expect(res.effectiveMode).toBe('on');
      expect(res.logLine).toBe(
        'TLS certificate verification: on (NODE_TLS_REJECT_UNAUTHORIZED=1 in environment)',
      );
    });

    it('NEVER writes to NODE_TLS_REJECT_UNAUTHORIZED', () => {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      configureTlsVerification();
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    });
  });

  describe('CA loading and de-duplication', () => {
    it('calls setDefaultCACertificates with de-duplicated default and system CAs', () => {
      const defaultCerts = ['certA', 'certB'];
      const systemCerts = ['certB', 'certC'];
      let passedCerts: any[] = [];

      const mockTls = {
        getCACertificates: jest.fn((type: string) => {
          if (type === 'default') return defaultCerts;
          if (type === 'system') return systemCerts;
          return [];
        }),
        setDefaultCACertificates: jest.fn((certs: any[]) => {
          passedCerts = certs;
        }),
      };

      const res = configureTlsVerification({ tlsModule: mockTls });
      expect(res.effectiveMode).toBe('on');
      expect(mockTls.setDefaultCACertificates).toHaveBeenCalled();
      expect(passedCerts).toEqual(['certA', 'certB', 'certC']);
      expect(res.logLine).toMatch(/bundled \+ (Windows|system) CAs/);
    });

    it('survives missing CA functions without crashing and reports bundled only', () => {
      const mockTls = {};

      const res = configureTlsVerification({ tlsModule: mockTls });
      expect(res.effectiveMode).toBe('on');
      expect(res.logLine).toContain('bundled only');
    });

    it('survives throw from CA functions without crashing and reports bundled only', () => {
      const mockTls = {
        getCACertificates: jest.fn(() => {
          throw new Error('Not supported on this platform');
        }),
        setDefaultCACertificates: jest.fn(),
      };

      const res = configureTlsVerification({ tlsModule: mockTls });
      expect(res.effectiveMode).toBe('on');
      expect(res.logLine).toContain('bundled only');
    });
  });

  describe('Diagnostic logging to stderr', () => {
    it('writes log line to stderr and never stdout', () => {
      const stdoutSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const stderrSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      try {
        hydrateAndConfigureTls();
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining('TLS certificate verification:'),
        );
        expect(stdoutSpy).not.toHaveBeenCalled();
      } finally {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    });
  });

  describe('return_error certificate hint (§3.8)', () => {
    it.each(
      TLS_CERT_ERROR_CODES,
    )('appends hint when error.code is %s', (code) => {
      const err: any = new Error(`Connection failed: ${code}`);
      err.code = code;

      const res = return_error(err);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain(code);
      expect(res.content[0].text).toContain(TLS_CERT_HINT);
      expect(res.content[0].text.endsWith(TLS_CERT_HINT)).toBe(true);
      // Verify nothing is prepended
      expect(res.content[0].text.startsWith('Connection failed')).toBe(true);
    });

    it('appends hint when certificate error is nested in error.cause', () => {
      const rootCause: any = new Error('Leaf cert invalid');
      rootCause.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';

      const outerError = new Error('ADT request failed', { cause: rootCause });

      const res = return_error(outerError);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain(TLS_CERT_HINT);
      expect(res.content[0].text.startsWith('ADT request failed')).toBe(true);
    });

    it('does NOT append hint for unrelated errors', () => {
      const err = new Error('ECONNREFUSED: Connection refused 127.0.0.1:44300');
      const res = return_error(err);
      expect(res.content[0].text).not.toContain(TLS_CERT_HINT);
    });
  });
});
