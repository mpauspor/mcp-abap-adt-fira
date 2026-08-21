/**
 * DebuggerStop - detach the debugger and release the debuggee.
 *
 * Always worth calling: an abandoned listener keeps the user's dialog session
 * captive and blocks a later Eclipse debugger session for the same user.
 */

import { AbapDebugger } from '@mcp-abap-adt/adt-clients';
import {
  getDebuggerIdentity,
  getDebuggerUser,
} from '../../../lib/adt/debuggerIdentity';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, return_response } from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'DebuggerStop',
  available_in: ['onprem'] as const,
  description:
    "[debugger] Detach the debugger listener and release the debuggee. Call this when finished — an abandoned listener holds the user's session captive and blocks a later Eclipse debugger session for the same user.",
  inputSchema: {
    type: 'object',
    properties: {
      request_user: {
        type: 'string',
        description:
          'User the listener was registered for. Defaults to the connection user.',
      },
      debugging_mode: {
        type: 'string',
        description:
          "Must match the mode used in DebuggerListen. Default 'user'.",
      },
    },
  },
} as const;

export async function handleDebuggerStop(
  context: HandlerContext,
  args: { request_user?: string; debugging_mode?: string },
) {
  const { connection, logger } = context;
  try {
    const identity = getDebuggerIdentity();
    const requestUser = getDebuggerUser(args?.request_user);

    const abapDebugger = new AbapDebugger(connection, logger as any);
    const response = await abapDebugger.stop({
      debuggingMode: args?.debugging_mode || 'user',
      requestUser,
      ideId: identity.ideId,
      terminalId: identity.terminalId,
      checkConflict: false,
    });

    // The debugging session held this connection stateful; release it so later
    // reads are not pinned to it.
    connection.setSessionType('stateless');

    logger?.info(`DebuggerStop: listener released for ${requestUser}`);

    return return_response({
      data: JSON.stringify(
        {
          success: true,
          request_user: requestUser,
          ide_id: identity.ideId,
          message: 'Debugger listener stopped and debuggee released.',
        },
        null,
        2,
      ),
      status: response.status ?? 200,
      statusText: response.statusText ?? 'OK',
      headers: {},
      config: {} as any,
    });
  } catch (error: any) {
    // Stopping a listener that is not running is a no-op, not a failure —
    // and this tool needs to stay safe to call defensively.
    if (error?.response?.status === 404) {
      return return_response({
        data: JSON.stringify(
          {
            success: true,
            message: 'No debugger listener was running.',
          },
          null,
          2,
        ),
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      });
    }
    logger?.error(`DebuggerStop failed: ${error?.message || error}`);
    return return_error(error);
  }
}
