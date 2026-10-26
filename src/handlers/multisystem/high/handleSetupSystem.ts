/**
 * SetupSystem — creates a session .env file from SAP Logon landscape data.
 */

import type { HandlerContext } from '../../../lib/handlers/interfaces.js';
import {
  checkCredentialTarget,
  probeSystem,
  readLandscapeFile,
  validateSessionName,
  writeSessionFile,
} from '../../../lib/landscape/index.js';
import { return_error, return_response } from '../../../lib/utils.js';

export const TOOL_DEFINITION = {
  name: 'SetupSystem',
  description:
    'Create or update an environment session file (.env) for a target SAP system from its SAP Logon landscape XML entry, probe reachability and TLS, and check Windows Credential Manager.',
  inputSchema: {
    type: 'object',
    properties: {
      service_uuid: {
        type: 'string',
        description:
          'Service UUID from SAP Logon landscape (as returned by ListLandscapeSystems).',
      },
      client: {
        type: 'string',
        description: '3-digit SAP client number (e.g. "100").',
      },
      username: {
        type: 'string',
        description: 'SAP username (1 to 12 characters).',
      },
      name: {
        type: 'string',
        description:
          'Name of the session file to create (e.g. "qas"). Defaults to lowercase SID if unique in the landscape.',
      },
      url: {
        type: 'string',
        description:
          'Optional override for the ADT URL (e.g. "https://sapqas.example.com:44300").',
      },
      system_type: {
        type: 'string',
        enum: ['onprem', 'legacy', 'cloud'],
        description:
          'System type: "onprem", "legacy", or "cloud". Default: "onprem".',
      },
      language: {
        type: 'string',
        description: 'SAP logon language (e.g. "es", "en"). Default: "es".',
      },
      require_reachable: {
        type: 'boolean',
        description:
          'If true, fail if the target system cannot be reached over network. Default: false.',
      },
      allow_untrusted_tls: {
        type: 'boolean',
        description:
          'If true and target TLS certificate is untrusted, write TLS_REJECT_UNAUTHORIZED=0. Default: false.',
      },
      overwrite: {
        type: 'boolean',
        description:
          'If true, overwrite existing session file if it exists. Default: false.',
      },
      landscape_path: {
        type: 'string',
        description:
          'Optional path to SAPUILandscape.xml. Defaults to SAP_LANDSCAPE_PATH or standard location.',
      },
    },
    required: ['service_uuid', 'client', 'username'],
    additionalProperties: false,
  },
} as const;

export interface SetupSystemArgs {
  service_uuid: string;
  client: string;
  username: string;
  name?: string;
  url?: string;
  system_type?: 'onprem' | 'legacy' | 'cloud';
  language?: string;
  require_reachable?: boolean;
  allow_untrusted_tls?: boolean;
  overwrite?: boolean;
  landscape_path?: string;
  [key: string]: unknown;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional check for control characters
const CONTROL_CHARS_REGEX = /[\r\n\x00-\x1f\x7f]/;

export async function handleSetupSystem(
  context: HandlerContext,
  args: SetupSystemArgs,
) {
  const { logger } = context;
  try {
    const allowedKeys = new Set([
      'service_uuid',
      'client',
      'username',
      'name',
      'url',
      'system_type',
      'language',
      'require_reachable',
      'allow_untrusted_tls',
      'overwrite',
      'landscape_path',
    ]);
    const unknownKeys = Object.keys(args || {}).filter(
      (k) => !allowedKeys.has(k),
    );
    if (unknownKeys.length > 0) {
      throw new Error(`Unexpected property: ${unknownKeys.join(', ')}`);
    }

    if (!args?.service_uuid) {
      throw new Error('service_uuid is required.');
    }

    const client = String(args.client ?? '').trim();
    if (!/^\d{3}$/.test(client)) {
      throw new Error(
        `Invalid client "${args.client}". Client must be a 3-digit number (e.g. "100").`,
      );
    }

    const rawUsername =
      args.username !== undefined ? String(args.username) : '';
    if (
      CONTROL_CHARS_REGEX.test(rawUsername) ||
      rawUsername.trim().length < 1 ||
      rawUsername.trim().length > 12
    ) {
      throw new Error(
        `Invalid username "${args.username}". Username must be between 1 and 12 characters and contain no control characters or newlines.`,
      );
    }
    const username = rawUsername.trim();

    const rawLanguage =
      args.language !== undefined ? String(args.language) : 'es';
    if (
      CONTROL_CHARS_REGEX.test(rawLanguage) ||
      !/^[a-z]{2}$/.test(rawLanguage.trim())
    ) {
      throw new Error(
        `Invalid language "${args.language}". Language must be a 2-letter lowercase code (e.g. "es", "en").`,
      );
    }
    const language = rawLanguage.trim();

    const systemType = args.system_type || 'onprem';
    if (!['onprem', 'legacy', 'cloud'].includes(systemType)) {
      throw new Error(
        `Invalid system_type "${args.system_type}". Allowed values: onprem, legacy, cloud.`,
      );
    }

    const parseResult = readLandscapeFile(args.landscape_path);
    const service = parseResult.systems.find(
      (s) => s.service_uuid === args.service_uuid,
    );

    if (!service) {
      throw new Error(
        `No SAP Logon entry with uuid ${args.service_uuid} in ${parseResult.landscape_path}. Run ListLandscapeSystems.`,
      );
    }

    let sessionName = args.name ? args.name.trim() : '';
    if (!sessionName) {
      if (!service.sid) {
        throw new Error(
          `Entry "${service.name}" (${service.service_uuid}) has no SID. Please specify a session "name".`,
        );
      }
      if (!service.sid_is_unique) {
        throw new Error(
          `SID "${service.sid}" appears multiple times in the landscape; pass "name" to tell them apart.`,
        );
      }
      sessionName = service.sid.toLowerCase();
    }
    validateSessionName(sessionName);

    let finalUrl = '';
    const rawUrl = args.url !== undefined ? String(args.url) : '';
    const urlSource: 'derived' | 'explicit' = rawUrl
      ? 'explicit'
      : (service.url_source ?? 'derived');

    if (rawUrl) {
      if (CONTROL_CHARS_REGEX.test(rawUrl)) {
        throw new Error(
          `Invalid URL "${rawUrl}". URL must not contain newlines or control characters.`,
        );
      }
      const trimmedUrl = rawUrl.trim();
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(trimmedUrl);
      } catch {
        throw new Error(`Invalid URL "${rawUrl}".`);
      }
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        throw new Error(
          `Invalid URL "${rawUrl}". Protocol must be https: or http:.`,
        );
      }
      if (parsedUrl.username || parsedUrl.password) {
        throw new Error(
          `Invalid URL "${rawUrl}". User info is not allowed in URL.`,
        );
      }
      if (parsedUrl.pathname && parsedUrl.pathname !== '/') {
        throw new Error(
          `Invalid URL "${rawUrl}". URL must not contain a path.`,
        );
      }
      if (parsedUrl.search) {
        throw new Error(
          `Invalid URL "${rawUrl}". URL must not contain a query string.`,
        );
      }
      if (parsedUrl.hash) {
        throw new Error(
          `Invalid URL "${rawUrl}". URL must not contain a hash/fragment.`,
        );
      }
      finalUrl = parsedUrl.origin;
    } else if (service.proposed_url) {
      finalUrl = service.proposed_url;
    } else {
      throw new Error(
        `Cannot derive an ADT URL for "${service.name}" (${service.url_reason || 'unknown'}). Pass url.`,
      );
    }

    const warnings: string[] = [];
    if (service.via_saprouter) {
      warnings.push(
        `Service "${service.name}" uses SAProuter. ADT requires direct HTTP(S) access to the application server.`,
      );
    }

    const credentialTarget = `mcp-abap-adt:${sessionName}`;

    const probe = await probeSystem(finalUrl);

    if (args.require_reachable && !probe.reachable) {
      const u = new URL(finalUrl);
      throw new Error(
        `${u.hostname} is not reachable (${probe.error || 'unreachable'}). Connect the VPN, or drop require_reachable.`,
      );
    }

    if (!probe.reachable) {
      const u = new URL(finalUrl);
      warnings.push(
        `${u.hostname} is not reachable (${probe.error || 'unreachable'}). If connecting over VPN, verify connection.`,
      );
    }

    const writeRes = writeSessionFile({
      name: sessionName,
      serviceName: service.name,
      serviceUuid: service.service_uuid,
      url: finalUrl,
      client,
      username,
      sid: service.sid,
      systemType,
      language,
      probe,
      overwrite: args.overwrite ?? false,
      allowUntrustedTls: args.allow_untrusted_tls ?? false,
    });
    warnings.push(...writeRes.warnings);

    let credentialExists: boolean | 'unknown' = false;
    try {
      const credCheck = checkCredentialTarget(credentialTarget);
      credentialExists = credCheck.present;
    } catch {
      credentialExists = 'unknown';
    }

    const next_steps = [
      `cmdkey /generic:${credentialTarget} /user:${username} /pass`,
      `Use ${sessionName} as target_system in the Compare* tools now, or restart the MCP client with --env=${sessionName} to make it the active system. Whether ADT accepts the user is only known at that first call.`,
    ];

    return return_response({
      data: JSON.stringify(
        {
          success: true,
          name: sessionName,
          env_path: writeRes.envPath,
          verified: true,
          url: finalUrl,
          url_source: urlSource,
          probe,
          credential: {
            target: credentialTarget,
            present: credentialExists,
          },
          next_steps,
          warnings,
          hint: 'Language and TLS take effect through the launcher; a value in the process environment wins; TLS is process-wide.',
        },
        null,
        2,
      ),
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    });
  } catch (error: any) {
    if (typeof logger?.error === 'function') {
      logger.error(`SetupSystem failed: ${error?.message || error}`);
    }
    return return_error(error);
  }
}
