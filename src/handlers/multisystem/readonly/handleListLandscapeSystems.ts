/**
 * ListLandscapeSystems - enumerate SAP systems from the local SAP Logon landscape XML.
 */

import type { HandlerContext } from '../../../lib/handlers/interfaces.js';
import { probeBatch, readLandscapeFile } from '../../../lib/landscape/index.js';
import { return_error, return_response } from '../../../lib/utils.js';

export const TOOL_DEFINITION = {
  name: 'ListLandscapeSystems',
  description:
    '[read-only] Enumerate SAP systems defined in the local SAP Logon landscape XML file (SAPUILandscape.xml), derive ADT URLs, correlate with existing session files, and optionally probe reachability.',
  inputSchema: {
    type: 'object',
    properties: {
      landscape_path: {
        type: 'string',
        description:
          'Path to SAPUILandscape.xml. Defaults to SAP_LANDSCAPE_PATH or %APPDATA%\\SAP\\Common\\SAPUILandscape.xml.',
      },
      folder: {
        type: 'string',
        description:
          'Case-insensitive substring match against any folder segment. Used to narrow to one customer.',
      },
      probe: {
        type: 'boolean',
        description:
          'Whether to probe network reachability and TLS status of derived ADT URLs. Default is false.',
      },
      probe_limit: {
        type: 'integer',
        description:
          'Maximum number of matching systems to probe when probe is true. Default: 10, max: 25.',
      },
    },
    additionalProperties: false,
  },
} as const;

export interface ListLandscapeSystemsArgs {
  landscape_path?: string;
  folder?: string;
  probe?: boolean;
  probe_limit?: number;
  [key: string]: unknown;
}

export async function handleListLandscapeSystems(
  context: HandlerContext,
  args: ListLandscapeSystemsArgs,
) {
  const { logger } = context;
  try {
    const allowedKeys = new Set([
      'landscape_path',
      'folder',
      'probe',
      'probe_limit',
    ]);
    const unknownKeys = Object.keys(args || {}).filter(
      (k) => !allowedKeys.has(k),
    );
    if (unknownKeys.length > 0) {
      throw new Error(`Unexpected property: ${unknownKeys.join(', ')}`);
    }

    const parseResult = readLandscapeFile(args?.landscape_path);

    let systems = parseResult.systems;
    if (args?.folder && args.folder.trim()) {
      const q = args.folder.trim().toLowerCase();
      systems = systems.filter((sys) =>
        sys.folders.some((chain) =>
          chain.some((segment) => segment.toLowerCase().includes(q)),
        ),
      );
    }

    if (args?.probe) {
      const probeLimit = Math.min(Math.max(1, args.probe_limit ?? 10), 25);
      if (systems.length > probeLimit) {
        throw new Error(
          `${systems.length} systems match; probing contacts each host. Narrow with folder= (limit ${probeLimit}).`,
        );
      }
      await probeBatch(systems, 5, 10000);
    }

    return return_response({
      data: JSON.stringify(
        {
          success: true,
          landscape_path: parseResult.landscape_path,
          files_read: parseResult.files_read,
          unresolved_includes: parseResult.unresolved_includes,
          count: systems.length,
          systems,
          warnings: parseResult.warnings,
          hint: 'Pick a system and call SetupSystem with its service_uuid.',
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
      logger.error(`ListLandscapeSystems failed: ${error?.message || error}`);
    }
    return return_error(error);
  }
}
