/**
 * DebuggerStep - advance the attached debuggee.
 *
 * Uses the batched step variants, which fetch the new call stack in the same
 * round trip as the step itself, so the caller does not have to follow every
 * step with a separate DebuggerGetStack.
 */

import { AbapDebugger } from '@mcp-abap-adt/adt-clients';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, return_response } from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'DebuggerStep',
  available_in: ['onprem'] as const,
  description:
    '[debugger] Advance the attached debuggee one step and return the resulting call stack. Requires an active session from DebuggerListen. Note that "continue" runs until the next breakpoint, which may end the session entirely.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['step_into', 'step_over', 'step_return', 'continue'],
        description:
          "Step action. 'step_into' enters the called routine, 'step_over' runs it to completion, 'step_return' runs to the caller, 'continue' resumes until the next breakpoint.",
      },
    },
    required: ['action'],
  },
} as const;

export async function handleDebuggerStep(
  context: HandlerContext,
  args: { action?: string },
) {
  const { connection, logger } = context;
  try {
    const action = args?.action;
    if (!action) {
      return return_error(
        'action is required (step_into, step_over, step_return or continue)',
      );
    }

    const abapDebugger = new AbapDebugger(connection, logger as any);

    let response: any;
    switch (action) {
      case 'step_into':
        response = await abapDebugger.stepIntoBatch();
        break;
      case 'step_over':
        // 'stepOver' is the ADT action name; the batch helper covers into,
        // out and continue only, so this goes through executeAction.
        response = await abapDebugger.executeAction('stepOver');
        break;
      case 'step_return':
        response = await abapDebugger.stepOutBatch();
        break;
      case 'continue':
        response = await abapDebugger.stepContinueBatch();
        break;
      default:
        return return_error(
          `Unknown action "${action}". Use step_into, step_over, step_return or continue.`,
        );
    }

    return return_response({
      data: JSON.stringify(
        {
          success: true,
          action,
          result: response.data,
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
    const status = error?.response?.status;
    if (status === 404 || status === 409) {
      return return_error(
        new Error(
          'No debugger session is attached, or the debuggee has already finished. Run DebuggerListen to catch a new one.',
        ),
      );
    }
    logger?.error(`DebuggerStep failed: ${error?.message || error}`);
    return return_error(error);
  }
}
