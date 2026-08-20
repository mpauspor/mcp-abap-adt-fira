/**
 * AbapGitLink - link an ABAP package to a Git repository.
 *
 * Linking only records the association; it does not import anything. Follow
 * with AbapGitPull to bring the objects in.
 */

import { AdtAbapGitClient } from '@mcp-abap-adt/adt-clients';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, return_response } from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'AbapGitLink',
  available_in: ['onprem', 'cloud'] as const,
  description:
    'Link an ABAP package to a Git repository via ADT-integrated abapGit. This records the link only — no objects are imported. Follow with AbapGitPull.',
  inputSchema: {
    type: 'object',
    properties: {
      package_name: {
        type: 'string',
        description:
          'ABAP package to link (e.g., ZMY_PACKAGE). Must already exist.',
      },
      url: {
        type: 'string',
        description: 'Git repository URL.',
      },
      branch_name: {
        type: 'string',
        description: "Branch to track, e.g. 'refs/heads/main'.",
      },
      transport_request: {
        type: 'string',
        description: 'Transport request. Required for transportable packages.',
      },
      remote_user: {
        type: 'string',
        description: 'Git user, for a private repository.',
      },
      remote_password: {
        type: 'string',
        description:
          'Git password or personal access token, for a private repository.',
      },
    },
    required: ['package_name', 'url'],
  },
} as const;

interface AbapGitLinkArgs {
  package_name: string;
  url: string;
  branch_name?: string;
  transport_request?: string;
  remote_user?: string;
  remote_password?: string;
}

export async function handleAbapGitLink(
  context: HandlerContext,
  args: AbapGitLinkArgs,
) {
  const { connection, logger } = context;
  try {
    if (!args?.package_name || !args?.url) {
      return return_error('package_name and url are required');
    }

    const packageName = args.package_name.toUpperCase();
    const client = new AdtAbapGitClient(connection, logger);

    const existing = await client.getRepo(packageName);
    if (existing) {
      return return_error(
        new Error(
          `Package ${packageName} is already linked to ${existing.url} (branch ${existing.branchName}). Unlink it first with AbapGitUnlink.`,
        ),
      );
    }

    await client.link({
      package: packageName,
      url: args.url,
      branchName: args.branch_name,
      transportRequest: args.transport_request,
      remoteUser: args.remote_user,
      remotePassword: args.remote_password,
    });

    // link() resolves without a body, so read the link back rather than
    // reporting a state that was never observed.
    const linked = await client.getRepo(packageName);

    return return_response({
      data: JSON.stringify(
        {
          success: !!linked,
          package_name: packageName,
          repository: linked,
          message: linked
            ? `Package ${packageName} linked to ${args.url}. Run AbapGitPull to import the objects.`
            : `Link call succeeded but the link could not be read back for ${packageName}.`,
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
    logger?.error(`AbapGitLink failed: ${error?.message || error}`);
    return return_error(error);
  }
}
