/**
 * AbapGitGetErrorLog - read the per-object error log of the last abapGit
 * operation on a package.
 *
 * A pull reports an overall status but the reason a specific object failed
 * to import lives here, one entry per object.
 */

import { AdtAbapGitClient } from '@mcp-abap-adt/adt-clients';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, return_response } from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'AbapGitGetErrorLog',
  available_in: ['onprem', 'cloud'] as const,
  description:
    '[read-only] Read the per-object error log of the last abapGit operation on a package. Use after a failed AbapGitPull to find which objects failed and why.',
  inputSchema: {
    type: 'object',
    properties: {
      package_name: {
        type: 'string',
        description: 'ABAP package name (e.g., ZMY_PACKAGE).',
      },
    },
    required: ['package_name'],
  },
} as const;

export async function handleAbapGitGetErrorLog(
  context: HandlerContext,
  args: { package_name?: string },
) {
  const { connection, logger } = context;
  try {
    if (!args?.package_name) {
      return return_error('package_name is required');
    }

    const packageName = args.package_name.toUpperCase();
    const client = new AdtAbapGitClient(connection, logger);
    const entries = await client.getErrorLog(packageName);

    const errors = entries.filter((entry) => entry.msgType === 'E');

    return return_response({
      data: JSON.stringify(
        {
          success: true,
          package_name: packageName,
          count: entries.length,
          error_count: errors.length,
          entries,
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
    logger?.error(`AbapGitGetErrorLog failed: ${error?.message || error}`);
    return return_error(error);
  }
}
