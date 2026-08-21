/**
 * DebuggerGetStack - read the call stack of the attached debuggee.
 */

import { getStack } from '../../../lib/adt/debuggerSession';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, return_response } from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'DebuggerGetStack',
  available_in: ['onprem'] as const,
  description:
    '[debugger] Read the ABAP call stack of the currently attached debuggee. Requires an active debugger session from DebuggerListen.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
} as const;

export async function handleDebuggerGetStack(
  context: HandlerContext,
  _args: unknown,
) {
  const { connection, logger } = context;
  try {
    // Needs method=getStack; without it SAP does not recognise the request.
    const stack = await getStack(connection);

    return return_response({
      data: JSON.stringify({ success: true, stack }, null, 2),
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
          'No debugger session is attached. Run DebuggerListen first and wait for it to catch a debuggee.',
        ),
      );
    }
    logger?.error(`DebuggerGetStack failed: ${error?.message || error}`);
    return return_error(error);
  }
}
