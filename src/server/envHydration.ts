import * as fs from 'node:fs';
import * as tls from 'node:tls';
import * as dotenv from 'dotenv';

export interface HydrationResult {
  envFileLoaded: boolean;
  keysLoaded: string[];
  sessionFileTlsValue?: string;
}

/**
 * In v2 flow, .env can be loaded into auth-broker session storage without
 * populating process.env. System context resolver relies on process.env
 * for SAP_MASTER_SYSTEM / SAP_RESPONSIBLE, so bridge these values here.
 *
 * Per SPEC §3.8 & §5:
 * SAP_PASSWORD, SAP_JWT_TOKEN, SAP_REFRESH_TOKEN, and SAP_UAA_CLIENT_SECRET
 * are never copied.
 */
export function hydrateSystemContextFromEnvFile(
  envFilePath?: string,
): HydrationResult {
  if (!envFilePath || !fs.existsSync(envFilePath)) {
    return { envFileLoaded: false, keysLoaded: [] };
  }

  try {
    const parsed = dotenv.parse(fs.readFileSync(envFilePath, 'utf8'));
    const keys: string[] = [
      'SAP_MASTER_SYSTEM',
      'SAP_RESPONSIBLE',
      'SAP_USERNAME',
      'SAP_CLIENT',
      'SAP_CONNECTION_TYPE',
      'SAP_SYSTEM_TYPE',
      'SAP_LANGUAGE',
      'TLS_REJECT_UNAUTHORIZED',
      'SAP_CREDENTIAL_TARGET',
    ];

    const keysLoaded: string[] = [];
    for (const key of keys) {
      const value = parsed[key];
      if (process.env[key] === undefined && value !== undefined) {
        process.env[key] = value;
        keysLoaded.push(key);
      }
    }

    return {
      envFileLoaded: true,
      keysLoaded,
      sessionFileTlsValue: parsed.TLS_REJECT_UNAUTHORIZED,
    };
  } catch {
    // Ignore .env parse errors here; auth-broker initialization handles config validation.
    return { envFileLoaded: false, keysLoaded: [] };
  }
}

export interface TlsConfigurationResult {
  effectiveMode: 'on' | 'off';
  logLine: string;
}

/**
 * Configure process-wide TLS certificate verification per SPEC §3.8 (D-009).
 */
export function configureTlsVerification(options?: {
  envFileUsed?: boolean;
  tlsModule?: any;
}): TlsConfigurationResult {
  const tlsModule = options?.tlsModule || tls;
  let source = '';
  // 1. If neither TLS_REJECT_UNAUTHORIZED nor NODE_TLS_REJECT_UNAUTHORIZED is set, default to 1.
  // Never write to NODE_TLS_REJECT_UNAUTHORIZED.
  if (
    process.env.TLS_REJECT_UNAUTHORIZED === undefined &&
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined
  ) {
    process.env.TLS_REJECT_UNAUTHORIZED = '1';
    source = 'default';
  }

  // Determine effective mode per table in SPEC §3.8:
  let effectiveMode: 'on' | 'off' = 'on';
  let sourceDesc = '';

  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    effectiveMode = 'off';
    sourceDesc = 'NODE_TLS_REJECT_UNAUTHORIZED=0 in environment';
  } else if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '1') {
    effectiveMode = 'on';
    sourceDesc = 'NODE_TLS_REJECT_UNAUTHORIZED=1 in environment';
  } else {
    // NODE_TLS_REJECT_UNAUTHORIZED is unset
    if (process.env.TLS_REJECT_UNAUTHORIZED === '0') {
      effectiveMode = 'off';
      sourceDesc = options?.envFileUsed
        ? 'TLS_REJECT_UNAUTHORIZED=0 from session file'
        : 'TLS_REJECT_UNAUTHORIZED=0 in environment';
    } else {
      effectiveMode = 'on';
      if (source === 'default') {
        sourceDesc = 'default';
      } else if (options?.envFileUsed) {
        sourceDesc = 'session file';
      } else {
        sourceDesc = 'TLS_REJECT_UNAUTHORIZED=1 in environment';
      }
    }
  }

  // 2. Load system CAs if verification is on and runtime supports it
  let caSource = 'bundled only';
  if (effectiveMode === 'on') {
    if (
      typeof tlsModule.getCACertificates === 'function' &&
      typeof tlsModule.setDefaultCACertificates === 'function'
    ) {
      try {
        const defaultCerts = tlsModule.getCACertificates('default') || [];
        const systemCerts = tlsModule.getCACertificates('system') || [];
        const merged = Array.from(new Set([...defaultCerts, ...systemCerts]));
        tlsModule.setDefaultCACertificates(merged);
        const osLabel = process.platform === 'win32' ? 'Windows' : 'system';
        caSource = `bundled + ${osLabel} CAs`;
      } catch {
        caSource = 'bundled only';
      }
    } else {
      caSource = 'bundled only';
    }
  }

  // 3. Format logLine (to be written to stderr)
  let logLine: string;
  if (effectiveMode === 'off') {
    logLine = `TLS certificate verification: off (${sourceDesc})`;
  } else if (sourceDesc === 'default') {
    logLine = `TLS certificate verification: on (default; ${caSource})`;
  } else if (sourceDesc === 'session file') {
    logLine =
      caSource === 'bundled only'
        ? 'TLS certificate verification: on (session file; bundled only)'
        : 'TLS certificate verification: on (session file)';
  } else {
    logLine =
      caSource === 'bundled only'
        ? `TLS certificate verification: on (${sourceDesc}; bundled only)`
        : `TLS certificate verification: on (${sourceDesc})`;
  }

  return { effectiveMode, logLine };
}

/**
 * Hydrates environment from session file, configures TLS verification,
 * and writes the diagnostic log line to stderr.
 */
export function hydrateAndConfigureTls(envFilePath?: string): void {
  const hydration = hydrateSystemContextFromEnvFile(envFilePath);
  const tlsResult = configureTlsVerification({
    envFileUsed: hydration.envFileLoaded,
  });
  // Must go to stderr, never stdout (which carries MCP protocol in stdio mode)
  console.error(tlsResult.logLine);
}
