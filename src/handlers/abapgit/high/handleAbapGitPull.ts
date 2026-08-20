/**
 * AbapGitPull - pull a linked package from its Git repository.
 *
 * Pull is ASYNCHRONOUS server-side. The client waits for completion, but a
 * client-side timeout stops only the wait — the server job keeps running.
 * That distinction is carried into the result rather than hidden, because
 * re-issuing a pull against a still-running job is what corrupts the link.
 */

import { AdtAbapGitClient } from '@mcp-abap-adt/adt-clients';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, return_response } from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'AbapGitPull',
  available_in: ['onprem', 'cloud'] as const,
  description:
    "Pull a package from its linked Git repository via ADT-integrated abapGit. Asynchronous server-side: this waits for completion and reports the final status plus any per-object errors. If it times out, the server job continues — poll AbapGitGetRepo until status is not 'R' before pulling again.",
  inputSchema: {
    type: 'object',
    properties: {
      package_name: {
        type: 'string',
        description: 'ABAP package to pull into (e.g., ZMY_PACKAGE).',
      },
      branch_name: {
        type: 'string',
        description:
          "Branch to pull, e.g. 'refs/heads/main'. Defaults to the branch recorded on the link.",
      },
      transport_request: {
        type: 'string',
        description:
          'Transport request for the imported objects. Required for transportable packages.',
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
      max_wait_seconds: {
        type: 'number',
        description:
          'How long to wait for the server job before giving up on the wait (default 300). The job itself is not cancelled.',
      },
    },
    required: ['package_name'],
  },
} as const;

interface AbapGitPullArgs {
  package_name: string;
  branch_name?: string;
  transport_request?: string;
  remote_user?: string;
  remote_password?: string;
  max_wait_seconds?: number;
}

export async function handleAbapGitPull(
  context: HandlerContext,
  args: AbapGitPullArgs,
) {
  const { connection, logger } = context;
  try {
    if (!args?.package_name) {
      return return_error('package_name is required');
    }

    const packageName = args.package_name.toUpperCase();
    const client = new AdtAbapGitClient(connection, logger);

    // Refuse to stack a pull on top of a running one.
    const current = await client.getRepo(packageName);
    if (current?.status === 'R') {
      return return_error(
        new Error(
          `A pull is already running for package ${packageName}. Poll AbapGitGetRepo until status is not 'R' before pulling again.`,
        ),
      );
    }

    logger?.info(`AbapGitPull: starting pull for ${packageName}`);

    try {
      const result = await client.pull({
        package: packageName,
        branchName: args.branch_name,
        transportRequest: args.transport_request,
        remoteUser: args.remote_user,
        remotePassword: args.remote_password,
        maxPollDurationMs:
          typeof args.max_wait_seconds === 'number'
            ? Math.max(1, Math.trunc(args.max_wait_seconds)) * 1000
            : undefined,
      });

      const errors = (result.errorLog ?? []).filter(
        (entry) => entry.msgType === 'E',
      );

      return return_response({
        data: JSON.stringify(
          {
            success: errors.length === 0,
            package_name: packageName,
            final_status: result.finalStatus,
            error_count: errors.length,
            errors: errors.length > 0 ? errors : undefined,
            error_log: result.errorLog,
            message:
              errors.length === 0
                ? `Pull completed for ${packageName}`
                : `Pull completed for ${packageName} with ${errors.length} object error(s)`,
          },
          null,
          2,
        ),
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      });
    } catch (pullError: any) {
      // A timeout or abort stopped OUR wait, not the server's job. Saying so
      // is the difference between the caller polling and the caller re-pulling
      // into a job that is still running.
      if (
        pullError?.name === 'TimeoutError' ||
        pullError?.name === 'AbortError'
      ) {
        return return_error(
          new Error(
            `Stopped waiting for the pull of ${packageName} (${pullError.name}). The SERVER-SIDE JOB IS STILL RUNNING — do not pull again. Poll AbapGitGetRepo until status is not 'R'. Last known status: ${JSON.stringify(pullError.lastKnownStatus ?? 'unknown')}`,
          ),
        );
      }
      throw pullError;
    }
  } catch (error: any) {
    logger?.error(`AbapGitPull failed: ${error?.message || error}`);
    return return_error(error);
  }
}
