/**
 * DebuggerListen - register a debugger listener and wait for a debuggee.
 *
 * Exposes AbapDebugger from @mcp-abap-adt/adt-clients, which implements the
 * HTTP debugger endpoints (/sap/bc/adt/debugger/*) and had no MCP tool.
 *
 * This BLOCKS: SAP holds the request open until one of the user's sessions
 * reaches a breakpoint, or the timeout expires. Set a breakpoint and trigger
 * the code from SAP GUI or a browser while this is waiting.
 */

import {
  getDebuggerIdentity,
  getDebuggerUser,
} from '../../../lib/adt/debuggerIdentity';
import {
  attachDebuggee,
  parseDebuggee,
} from '../../../lib/adt/debuggerSession';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import {
  makeAdtRequestWithTimeout,
  return_error,
  return_response,
} from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'DebuggerListen',
  available_in: ['onprem'] as const,
  description:
    "[debugger] Register a debugger listener and WAIT for one of the user's sessions to hit a breakpoint. This call blocks until a debuggee is caught or the timeout expires. Workflow: set a breakpoint, call this, then trigger the code from SAP GUI or a browser; once it returns, use DebuggerGetStack / DebuggerGetVariables / DebuggerStep, and always finish with DebuggerStop.",
  inputSchema: {
    type: 'object',
    properties: {
      request_user: {
        type: 'string',
        description:
          'User whose sessions to listen for. Defaults to the connection user.',
      },
      timeout_seconds: {
        type: 'number',
        description:
          'How long to wait for a debuggee (default 120). Keep this below the MCP client timeout.',
      },
      debugging_mode: {
        type: 'string',
        description:
          "Debugging mode: 'user' (default) listens for a user's dialog sessions; 'terminal' listens for this terminal only.",
      },
    },
  },
} as const;

export async function handleDebuggerListen(
  context: HandlerContext,
  args: {
    request_user?: string;
    timeout_seconds?: number;
    debugging_mode?: string;
  },
) {
  const { connection, logger } = context;
  try {
    const identity = getDebuggerIdentity();
    const requestUser = getDebuggerUser(args?.request_user);

    if (!requestUser) {
      return return_error(
        'Could not determine the user to listen for. Pass request_user, or set SAP_RESPONSIBLE / SAP_USERNAME.',
      );
    }

    const timeoutSeconds =
      typeof args?.timeout_seconds === 'number' && args.timeout_seconds > 0
        ? Math.trunc(args.timeout_seconds)
        : 120;

    logger?.info(
      `DebuggerListen: waiting up to ${timeoutSeconds}s for ${requestUser} (ideId=${identity.ideId})`,
    );

    // NOT AbapDebugger.launch(): that issues a GET, and a GET against
    // /debugger/listeners returns 200 with an empty body in under half a
    // second — it never waits, so nothing is ever caught. Measured on a 7.5x
    // system:
    // GET returns in 0.3-0.5s regardless of the timeout parameter, while POST
    // holds the connection open. POST is the long-poll.
    const query = new URLSearchParams({
      debuggingMode: args?.debugging_mode || 'user',
      requestUser,
      terminalId: identity.terminalId,
      ideId: identity.ideId,
      checkConflict: 'true',
      isNotifiedOnConflict: 'true',
    });

    // A debugger session lives in a STATEFUL ABAP session: the attach, the
    // stack, the variables and every step must arrive on the same one. Sent
    // stateless, the attach reports success and every later call answers as
    // though nothing were attached. Same failure shape as an include lock
    // issued outside its session.
    connection.setSessionType('stateful');

    // The HTTP timeout has to outlast the wait we are asking SAP for,
    // otherwise the client aborts a listener that is working correctly.
    const httpTimeoutMs = (timeoutSeconds + 15) * 1000;

    let response: any;
    try {
      response = await makeAdtRequestWithTimeout(
        connection,
        `/sap/bc/adt/debugger/listeners?${query.toString()}`,
        'POST',
        httpTimeoutMs,
        null,
        undefined,
        {
          // A caught debuggee comes back in its own SAP media type, not plain
          // application/xml. Asking only for application/xml made SAP answer
          // 406 ExceptionResourceNotAcceptable — the listener HAD caught the
          // session and the response was thrown away in content negotiation.
          Accept: '*/*',
          'X-sap-adt-relation':
            'http://www.sap.com/adt/debugger/relations/launch',
        },
      );
    } catch (listenError: any) {
      // A client-side abort leaves the listener registered server-side, which
      // would hold the user's session captive on the next breakpoint.
      const isTimeout =
        listenError?.code === 'ECONNABORTED' ||
        /timeout/i.test(String(listenError?.message ?? ''));
      if (isTimeout) {
        return return_error(
          new Error(
            `Stopped waiting after ${timeoutSeconds}s without catching a debuggee. Run DebuggerStop to release the listener before trying again.`,
          ),
        );
      }
      throw listenError;
    }

    const body =
      typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data ?? '');

    // An empty body means the wait ended without catching anything — a normal
    // outcome, not an error.
    const caught = !!body && body.trim().length > 0 && body.includes('<');
    const debuggee = caught ? parseDebuggee(body) : undefined;

    // Attach immediately. Catching only yields a DEBUGGEE_ID; until the session
    // is attached to it every later call behaves as though nothing had been
    // caught, which is indistinguishable from the listener having failed.
    let attached = false;
    let reachedBreakpoints: any[] = [];
    if (debuggee) {
      try {
        const result = await attachDebuggee(
          connection,
          debuggee.debuggeeId,
          logger,
        );
        attached = true;
        reachedBreakpoints = result.reachedBreakpoints;
      } catch (attachError: any) {
        logger?.error(
          `Caught debuggee ${debuggee.debuggeeId} but could not attach: ${attachError?.message || attachError}`,
        );
      }
    }

    return return_response({
      data: JSON.stringify(
        {
          success: true,
          caught_debuggee: caught,
          attached,
          request_user: requestUser,
          ide_id: identity.ideId,
          timeout_seconds: timeoutSeconds,
          stopped_at: debuggee
            ? {
                program: debuggee.program,
                include: debuggee.include,
                line: debuggee.line,
                user: debuggee.user,
                debuggee_id: debuggee.debuggeeId,
              }
            : undefined,
          reached_breakpoints:
            reachedBreakpoints.length > 0 ? reachedBreakpoints : undefined,
          message: !caught
            ? `No session hit a breakpoint within ${timeoutSeconds}s. NOTE: external breakpoints catch HTTP/RFC sessions — a report run from SAP GUI goes to the classic debugger instead. Trigger the code with RuntimeRunProgram, RuntimeRunClass or an HTTP call.`
            : attached
              ? `Stopped in ${debuggee?.program} line ${debuggee?.line}. Use DebuggerGetStack and DebuggerGetVariable, then DebuggerStop when finished.`
              : 'A debuggee was caught but could not be attached; inspection calls will fail. Run DebuggerStop and retry.',
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
    logger?.error(`DebuggerListen failed: ${error?.message || error}`);
    return return_error(error);
  }
}
