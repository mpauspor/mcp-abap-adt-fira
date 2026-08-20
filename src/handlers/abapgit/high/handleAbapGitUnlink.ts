/**
 * AbapGitUnlink - remove the Git link from a package.
 *
 * Removes the association only; the ABAP objects stay in the package.
 */

import { AdtAbapGitClient } from '@mcp-abap-adt/adt-clients';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, return_response } from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'AbapGitUnlink',
  available_in: ['onprem', 'cloud'] as const,
  description:
    'Remove the abapGit link between an ABAP package and its Git repository. The ABAP objects in the package are NOT deleted — only the link is removed.',
  inputSchema: {
    type: 'object',
    properties: {
      package_name: {
        type: 'string',
        description: 'ABAP package to unlink (e.g., ZMY_PACKAGE).',
      },
      transport_request: {
        type: 'string',
        description: 'Transport request. Required for transportable packages.',
      },
    },
    required: ['package_name'],
  },
} as const;

export async function handleAbapGitUnlink(
  context: HandlerContext,
  args: { package_name?: string; transport_request?: string },
) {
  const { connection, logger } = context;
  try {
    if (!args?.package_name) {
      return return_error('package_name is required');
    }

    const packageName = args.package_name.toUpperCase();
    const client = new AdtAbapGitClient(connection, logger);

    const existing = await client.getRepo(packageName);
    if (!existing) {
      return return_error(
        new Error(`Package ${packageName} is not linked to a repository.`),
      );
    }
    if (existing.status === 'R') {
      return return_error(
        new Error(
          `A pull is still running for package ${packageName}. Unlinking now would leave the import half-applied. Poll AbapGitGetRepo until status is not 'R'.`,
        ),
      );
    }

    await client.unlink({
      package: packageName,
      transportRequest: args.transport_request,
    });

    const stillLinked = await client.getRepo(packageName);

    return return_response({
      data: JSON.stringify(
        {
          success: !stillLinked,
          package_name: packageName,
          previous_repository: existing,
          message: stillLinked
            ? `Unlink call succeeded but ${packageName} still reports a link.`
            : `Package ${packageName} unlinked from ${existing.url}.`,
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
    logger?.error(`AbapGitUnlink failed: ${error?.message || error}`);
    return return_error(error);
  }
}
