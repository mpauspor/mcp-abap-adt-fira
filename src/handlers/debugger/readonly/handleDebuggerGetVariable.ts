/**
 * DebuggerGetVariable - read variable values from the attached debuggee.
 *
 * With no name, lists what is visible in the current frame; with names, reads
 * those. Both calls demand a SAP-specific media type — `application/xml` is
 * refused with a 406.
 */

import {
  getChildVariables,
  getVariables,
} from '../../../lib/adt/debuggerSession';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, return_response } from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'DebuggerGetVariable',
  available_in: ['onprem'] as const,
  description:
    '[debugger] Read variables from the attached debuggee. Pass variable_name (or variable_names) to read specific ones; omit both to list what is visible in the current stack frame. Requires an active session from DebuggerListen.',
  inputSchema: {
    type: 'object',
    properties: {
      variable_name: {
        type: 'string',
        description: 'Variable to read, as written in ABAP, e.g. GV_INDEX.',
      },
      variable_names: {
        type: 'array',
        items: { type: 'string' },
        description: 'Several variables at once.',
      },
      parent: {
        type: 'string',
        description:
          "When listing, the node to expand. Defaults to '@ROOT' (the current frame). Pass a structure or table name to expand its components.",
      },
    },
  },
} as const;

interface GetVariableArgs {
  variable_name?: string;
  variable_names?: string[];
  parent?: string;
}

export async function handleDebuggerGetVariable(
  context: HandlerContext,
  args: GetVariableArgs,
) {
  const { connection, logger } = context;
  try {
    const names = [
      ...(args?.variable_name ? [args.variable_name] : []),
      ...(Array.isArray(args?.variable_names) ? args.variable_names : []),
    ]
      .map((name) => String(name).trim().toUpperCase())
      .filter(Boolean);

    const listing = names.length === 0;
    const data = listing
      ? await getChildVariables(connection, [args?.parent || '@ROOT'])
      : await getVariables(connection, names);

    logger?.debug(
      listing
        ? `Listed variables under ${args?.parent || '@ROOT'}`
        : `Read ${names.length} variable(s)`,
    );

    return return_response({
      data: JSON.stringify(
        {
          success: true,
          mode: listing ? 'list' : 'read',
          requested: listing ? undefined : names,
          parent: listing ? args?.parent || '@ROOT' : undefined,
          variables: data,
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
    const status = error?.response?.status;
    if (status === 404 || status === 409) {
      return return_error(
        new Error(
          'No debugger session is attached. Run DebuggerListen and wait for it to catch a debuggee.',
        ),
      );
    }
    // SAP explains an unknown or out-of-scope variable precisely; passing that
    // through beats a generic failure.
    const body = error?.response?.data;
    const message =
      typeof body === 'string'
        ? (body.match(/<message[^>]*>([^<]*)</) || [])[1]
        : undefined;
    if (message) {
      return return_error(new Error(message));
    }

    logger?.error(`DebuggerGetVariable failed: ${error?.message || error}`);
    return return_error(error);
  }
}
