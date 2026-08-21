/**
 * Read-only connections to ADDITIONAL SAP systems, for cross-system comparison.
 *
 * The server runs against one system, chosen at startup with `--env=<name>`
 * (resolved to `sessions/<name>.env`). That naming scheme is reused here to
 * reach a SECOND system from the same process, so DEV can be diffed against
 * QAS or PRD without restarting anything.
 *
 * Two deliberate constraints:
 *
 * 1. Read-only. Nothing here writes, locks or activates. A comparison tool that
 *    can mutate the far system is a foot-gun, and the far system is typically
 *    the one you least want to touch.
 * 2. No `createAdtClient` for source reads. That factory reads the process
 *    -global `systemContext`, whose own comment states "one MCP session always
 *    maps to one SAP system". Its `isLegacy` flag picks `AdtClient` vs
 *    `AdtClientLegacy`, so a secondary system of a different release would get
 *    the wrong class. Reading through `makeAdtRequestWithTimeout` sidesteps the
 *    singleton entirely instead of refactoring it.
 *
 * Known limitation: TLS verification is a PROCESS-wide setting
 * (TLS_REJECT_UNAUTHORIZED / NODE_TLS_REJECT_UNAUTHORIZED), not per connection.
 * A secondary system inherits whatever the process was started with.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createAbapConnection } from '@mcp-abap-adt/connection';
import type { IAbapConnection, ILogger } from '@mcp-abap-adt/interfaces';
import { resolveEnvFilePath } from '../config/envResolver';
import { getPlatformPaths } from '../stores/platformPaths';
import { getSystemContext } from '../systemContext';
import { makeAdtRequestWithTimeout } from '../utils';

export interface SecondarySystemInfo {
  /** Name to pass to the compare tools (the env file name without .env). */
  name: string;
  url?: string;
  client?: string;
  system_id?: string;
  system_type?: string;
  auth_type?: string;
  env_path: string;
  /** Whether the file carries a usable credential. Never the credential itself. */
  has_credentials: boolean;
}

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Directories that hold named system definitions. */
export function sessionsDirectories(): string[] {
  return getPlatformPaths(undefined, 'sessions').filter(
    (dir) => path.basename(dir) === 'sessions',
  );
}

/**
 * Enumerate the systems this server can reach besides the current one.
 *
 * Reports connection metadata only — never a password or token.
 */
export function listAvailableSystems(): SecondarySystemInfo[] {
  const systems: SecondarySystemInfo[] = [];
  const seen = new Set<string>();

  for (const dir of sessionsDirectories()) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // An absent directory is the normal case, not an error.
    }

    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.env')) continue;
      const name = entry.slice(0, -4);
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());

      const envPath = path.join(dir, entry);
      let env: Record<string, string> = {};
      try {
        env = parseEnvFile(envPath);
      } catch {
        /* an unreadable file is still worth listing */
      }

      systems.push({
        name,
        url: env.SAP_URL,
        client: env.SAP_CLIENT,
        system_id: env.SAP_MASTER_SYSTEM,
        system_type: env.SAP_SYSTEM_TYPE,
        auth_type: env.SAP_AUTH_TYPE,
        env_path: envPath,
        has_credentials: !!(
          env.SAP_PASSWORD ||
          env.SAP_JWT_TOKEN ||
          env.SAP_CERT_PFX_PATH
        ),
      });
    }
  }

  return systems.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Connection metadata for the system the server itself is running against.
 *
 * Deliberately does NOT trust `process.env`. When the server is started with
 * `--env-path`, only some variables reach the process environment —
 * SAP_MASTER_SYSTEM and SAP_CLIENT arrive, SAP_URL does not — so reading the
 * environment reported a current system with no URL while every secondary
 * system showed one. The live connection is the authoritative source; the
 * environment is only a last resort.
 *
 * `getBaseUrl()` is on the IAbapConnection interface. `getConfig()` is not — it
 * exists on the concrete connection classes — so it is feature-detected rather
 * than assumed.
 */
export async function currentSystemInfo(
  connection?: IAbapConnection,
): Promise<Record<string, string | undefined>> {
  const context = getSystemContext();
  const config: any = connection
    ? (connection as any).getConfig?.()
    : undefined;

  let url: string | undefined = config?.url;
  if (!url && connection?.getBaseUrl) {
    try {
      url = await connection.getBaseUrl();
    } catch {
      /* a connection that cannot report its URL is not a failure to list */
    }
  }

  return {
    url: url ?? process.env.SAP_URL,
    client: config?.client ?? context.client ?? process.env.SAP_CLIENT,
    system_id: context.masterSystem ?? process.env.SAP_MASTER_SYSTEM,
    system_type: process.env.SAP_SYSTEM_TYPE,
    auth_type: config?.authType ?? process.env.SAP_AUTH_TYPE,
    user: config?.username ?? context.responsible ?? process.env.SAP_USERNAME,
  };
}

const connectionsByName = new Map<string, IAbapConnection>();

/**
 * Open (or reuse) a read-only connection to a named system.
 *
 * @throws with an actionable message when the system is unknown or its
 *         definition is incomplete — the caller cannot otherwise guess which of
 *         several env keys is missing.
 */
export function getSecondaryConnection(
  systemName: string,
  logger?: ILogger,
): IAbapConnection {
  const key = systemName.trim().toLowerCase();
  const cached = connectionsByName.get(key);
  if (cached) return cached;

  const envPath = resolveEnvFilePath({ envDestination: systemName });
  if (!envPath || !fs.existsSync(envPath)) {
    const available = listAvailableSystems().map((s) => s.name);
    const where = sessionsDirectories()[0] ?? 'the sessions directory';
    throw new Error(
      `Unknown system "${systemName}". Expected a definition at ${envPath ?? '(unresolved)'}. ` +
        (available.length > 0
          ? `Available: ${available.join(', ')}.`
          : `No systems are defined yet — create ${where}/<name>.env. See ListSystems.`),
    );
  }

  const env = parseEnvFile(envPath);
  const missing = ['SAP_URL', 'SAP_USERNAME'].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `System "${systemName}" (${envPath}) is missing: ${missing.join(', ')}.`,
    );
  }
  if (!env.SAP_PASSWORD && (env.SAP_AUTH_TYPE ?? 'basic') === 'basic') {
    throw new Error(
      `System "${systemName}" (${envPath}) uses basic auth but has no SAP_PASSWORD.`,
    );
  }

  logger?.info(
    `Opening read-only connection to secondary system "${systemName}" (${env.SAP_URL}, client ${env.SAP_CLIENT ?? '-'})`,
  );

  const connection = createAbapConnection(
    {
      url: env.SAP_URL,
      client: env.SAP_CLIENT,
      authType: (env.SAP_AUTH_TYPE as any) || 'basic',
      connectionType: (env.SAP_CONNECTION_TYPE as any) || 'http',
      username: env.SAP_USERNAME,
      password: env.SAP_PASSWORD,
      jwtToken: env.SAP_JWT_TOKEN,
    },
    logger as any,
    `mcp-abap-adt-secondary-${key}`,
  );

  connectionsByName.set(key, connection);
  return connection;
}

/** Result of looking for one object's source in one system. */
export interface SourceProbe {
  found: boolean;
  source?: string;
  /** Why it was not found — 404 means absent, anything else is a real problem. */
  reason?: string;
}

/**
 * Fetch an object's source from a system.
 *
 * A 404 is reported as `found: false` rather than thrown: "this object does not
 * exist in QAS yet" is a comparison RESULT, not a failure of the comparison.
 */
export async function probeSource(
  connection: IAbapConnection,
  sourceUrl: string,
): Promise<SourceProbe> {
  try {
    const response = await makeAdtRequestWithTimeout(
      connection,
      sourceUrl,
      'GET',
      'default',
      undefined,
      undefined,
      { Accept: 'text/plain' },
    );
    const source =
      typeof response.data === 'string'
        ? response.data
        : String(response.data ?? '');
    return { found: true, source };
  } catch (error: any) {
    const status = error?.response?.status;
    if (status === 404) {
      return { found: false, reason: 'not found in this system' };
    }
    return {
      found: false,
      reason: `read failed (HTTP ${status ?? '?'}): ${error?.message ?? error}`,
    };
  }
}

/**
 * Compare two sources the way a reviewer would: ignoring the line-ending and
 * trailing-whitespace noise that differs between systems without any developer
 * having changed anything.
 */
export function normalizeForComparison(source: string): string {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}
