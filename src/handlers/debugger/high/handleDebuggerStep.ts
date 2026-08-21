/**
 * DebuggerStep - advance the attached debuggee.
 *
 * Uses the batched step variants, which fetch the new call stack in the same
 * round trip as the step itself, so the caller does not have to follow every
 * step with a separate DebuggerGetStack.
 */

import { type DebugStep, step } from '../../../lib/adt/debuggerSession';
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

    // SAP's own action names, passed as method= on /sap/bc/adt/debugger.
    const actions: Record<string, DebugStep> = {
      step_into: 'stepInto',
      step_over: 'stepOver',
      step_return: 'stepReturn',
      continue: 'stepContinue',
      terminate: 'terminateDebuggee',
    };

    const mapped = actions[action];
    if (!mapped) {
      return return_error(
        `Unknown action "${action}". Use step_into, step_over, step_return, continue or terminate.`,
      );
    }

    const result = await step(connection, mapped, logger);

    return return_response({
      data: JSON.stringify(
        {
          success: true,
          action,
          sap_action: mapped,
          result,
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
    // Continuing a program with no further breakpoints runs it to completion.
    // SAP reports that as an exception carrying subType=debuggeeEnded, but it
    // is the expected outcome of `continue`, not a failure — surfacing it as an
    // error would make a normal finish look broken.
    const body = String(error?.response?.data ?? '');
    if (body.includes('debuggeeEnded')) {
      return return_response({
        data: JSON.stringify(
          {
            success: true,
            action: args?.action,
            debuggee_ended: true,
            message:
              'The program ran to completion and the debug session ended. Nothing is attached now — run DebuggerListen again to catch another execution.',
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
