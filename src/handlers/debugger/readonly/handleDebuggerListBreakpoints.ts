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
    '[debugger] List the external breakpoints this server has registered, with the id needed to delete one. Two things it cannot show: breakpoints set in SAP GUI (those are session breakpoints ADT cannot see) and breakpoints left by an earlier run of this server — SAP offers no way to read the set back. DebuggerDeleteBreakpoint with all=true clears those regardless.',
  inputSchema: { type: 'object', properties: {} },
} as const;

export async function handleDebuggerListBreakpoints(
  context: HandlerContext,
  _args: unknown,
) {
  const { logger } = context;
  try {
    const breakpoints = listBreakpoints();
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
              ? 'This server has no breakpoints registered. Use DebuggerSetBreakpoint before DebuggerListen, or the listener will never fire.'
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
