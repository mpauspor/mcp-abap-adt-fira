/**
 * AbapGitListRepos - list packages linked to a Git repository.
 *
 * Wraps AdtAbapGitClient from @mcp-abap-adt/adt-clients, which implements the
 * ADT-integrated abapGit endpoints (/sap/bc/adt/abapgit/*) but was not exposed
 * as an MCP tool.
 */

import { AdtAbapGitClient } from '@mcp-abap-adt/adt-clients';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, return_response } from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'AbapGitListRepos',
  available_in: ['onprem', 'cloud'] as const,
  description:
    "[read-only] List all packages linked to a Git repository through ADT-integrated abapGit, with each link's URL, branch and status. Status R means a pull is still running.",
  inputSchema: {
    type: 'object',
    properties: {},
  },
} as const;

export async function handleAbapGitListRepos(
  context: HandlerContext,
  _args: unknown,
) {
  const { connection, logger } = context;
  try {
    const client = new AdtAbapGitClient(connection, logger);
    const repos = await client.listRepos();

    logger?.info(`AbapGitListRepos: ${repos.length} linked package(s)`);

    return return_response({
      data: JSON.stringify(
        { success: true, count: repos.length, repositories: repos },
        null,
        2,
      ),
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    });
  } catch (error: any) {
    logger?.error(`AbapGitListRepos failed: ${error?.message || error}`);
    return return_error(error);
  }
}
