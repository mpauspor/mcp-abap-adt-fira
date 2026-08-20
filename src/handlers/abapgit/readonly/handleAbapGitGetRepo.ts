/**
 * AbapGitGetRepo - read the Git link status of a single package.
 *
 * Also the correct way to wait out an in-flight pull: pull is asynchronous
 * server-side, so poll here until status is no longer 'R' before issuing
 * another pull or an unlink.
 */

import { AdtAbapGitClient } from '@mcp-abap-adt/adt-clients';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, return_response } from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'AbapGitGetRepo',
  available_in: ['onprem', 'cloud'] as const,
  description:
    "[read-only] Read the abapGit link status of one package: repository URL, branch and status. Poll this until status is not 'R' (running) before issuing another AbapGitPull or an AbapGitUnlink.",
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

export async function handleAbapGitGetRepo(
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
    const repo = await client.getRepo(packageName);

    if (!repo) {
      return return_error(
        new Error(
          `Package ${packageName} is not linked to a Git repository. Use AbapGitListRepos to see linked packages.`,
        ),
      );
    }

    return return_response({
      data: JSON.stringify(
        {
          success: true,
          repository: repo,
          pull_running: repo.status === 'R',
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
    logger?.error(`AbapGitGetRepo failed: ${error?.message || error}`);
    return return_error(error);
  }
}
