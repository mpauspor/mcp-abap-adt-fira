/**
 * DebuggerDeleteBreakpoint - remove an external breakpoint.
 *
 * Worth calling when finished. An external breakpoint outlives the session that
 * set it and will stop the user's next execution somewhere they have forgotten
 * about, which is hard to diagnose precisely because nothing on screen mentions
 * a debugger.
 */

import {
  deleteAllBreakpoints,
  deleteBreakpoint,
} from '../../../lib/adt/debuggerBreakpoints';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, return_response } from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'DebuggerDeleteBreakpoint',
  available_in: ['onprem'] as const,
  description:
    '[debugger] Remove one external breakpoint by its id (from DebuggerListBreakpoints), or all of them with all=true. An external breakpoint outlives the session that set it, so clean up when finished.',
  inputSchema: {
    type: 'object',
    properties: {
      breakpoint_id: {
        type: 'string',
        description: 'Id from DebuggerListBreakpoints.',
      },
      all: {
        type: 'boolean',
        description: 'Remove every registered breakpoint. Default false.',
      },
    },
  },
} as const;

export async function handleDebuggerDeleteBreakpoint(
  context: HandlerContext,
  args: { breakpoint_id?: string; all?: boolean },
) {
  const { connection, logger } = context;
  try {
    if (args?.all === true) {
      await deleteAllBreakpoints(connection, logger);
      return return_response({
        data: JSON.stringify(
          {
            success: true,
            removed: 'all',
            remaining: 0,
            message:
              'All external breakpoints removed, including any left by an earlier run of this server.',
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

    if (!args?.breakpoint_id) {
      return return_error(
        'breakpoint_id is required, or pass all=true to remove every breakpoint.',
      );
    }

    const remaining = await deleteBreakpoint(
      connection,
      args.breakpoint_id,
      logger,
    );

    return return_response({
      data: JSON.stringify(
        {
          success: true,
          removed: args.breakpoint_id,
          remaining: remaining.length,
          breakpoints: remaining,
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
    logger?.error(
      `DebuggerDeleteBreakpoint failed: ${error?.message || error}`,
    );
    return return_error(error);
  }
}
