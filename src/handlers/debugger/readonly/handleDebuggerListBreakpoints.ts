/**
 * DebuggerListBreakpoints - what this IDE identity currently has registered.
 *
 * Also the way to find the id DebuggerDeleteBreakpoint needs.
 */

import { listBreakpoints } from '../../../lib/adt/debuggerBreakpoints';
import { getDebuggerIdentity } from '../../../lib/adt/debuggerIdentity';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, return_response } from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'DebuggerListBreakpoints',
  available_in: ['onprem'] as const,
  description:
    '[debugger] List the external breakpoints registered for this IDE identity, with the id needed to delete one. Breakpoints set in SAP GUI do not appear here — they are session breakpoints and ADT cannot see them.',
  inputSchema: { type: 'object', properties: {} },
} as const;

export async function handleDebuggerListBreakpoints(
  context: HandlerContext,
  _args: unknown,
) {
  const { connection, logger } = context;
  try {
    const breakpoints = await listBreakpoints(connection);
    const identity = getDebuggerIdentity();

    return return_response({
      data: JSON.stringify(
        {
          success: true,
          ide_id: identity.ideId,
          count: breakpoints.length,
          breakpoints,
          message:
            breakpoints.length === 0
              ? 'No external breakpoints are registered. Use DebuggerSetBreakpoint before DebuggerListen, or the listener will never fire.'
              : `${breakpoints.length} breakpoint(s) registered.`,
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
    logger?.error(`DebuggerListBreakpoints failed: ${error?.message || error}`);
    return return_error(error);
  }
}
