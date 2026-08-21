/**
 * DebuggerSetBreakpoint - register an external breakpoint ADT can catch.
 *
 * This is the piece that makes the debugger usable from here. A breakpoint set
 * in SAP GUI is a session breakpoint: it opens the classic GUI debugger and is
 * invisible to the ADT listener, so DebuggerListen would wait forever.
 */

import {
  addBreakpoint,
  lineBreakpointUri,
} from '../../../lib/adt/debuggerBreakpoints';
import { getDebuggerIdentity } from '../../../lib/adt/debuggerIdentity';
import { buildObjectUri } from '../../../lib/adt/objectUri';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, return_response } from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'DebuggerSetBreakpoint',
  available_in: ['onprem'] as const,
  description:
    '[debugger] Register an external breakpoint that DebuggerListen can catch. Required before debugging: a breakpoint set in SAP GUI is a session breakpoint, invisible to ADT, so the listener would never fire. Existing breakpoints are preserved. Follow with DebuggerListen, then trigger the code.',
  inputSchema: {
    type: 'object',
    properties: {
      object_name: {
        type: 'string',
        description: 'Object holding the breakpoint, e.g. Z_MY_REPORT.',
      },
      object_type: {
        type: 'string',
        description:
          "Object type: 'PROG/P' (program), 'PROG/I' (include), 'CLAS/OC' (class), 'FUGR/FF' (function module).",
      },
      line: {
        type: 'number',
        description:
          'Line number in the source, counting from 1. Put it on an executable statement — a comment or a declaration never runs, so the breakpoint would never fire.',
      },
      parent_name: {
        type: 'string',
        description: 'Function group, required for function modules (FUGR/FF).',
      },
      condition: {
        type: 'string',
        description:
          'Optional ABAP condition, e.g. "gv_index > 10". The breakpoint only stops when it holds.',
      },
    },
    required: ['object_name', 'object_type', 'line'],
  },
} as const;

interface SetBreakpointArgs {
  object_name: string;
  object_type: string;
  line: number;
  parent_name?: string;
  condition?: string;
}

export async function handleDebuggerSetBreakpoint(
  context: HandlerContext,
  args: SetBreakpointArgs,
) {
  const { connection, logger } = context;
  try {
    if (!args?.object_name || !args?.object_type || !args?.line) {
      return return_error('object_name, object_type and line are required');
    }
    if (args.line < 1) {
      return return_error('line must be 1 or greater');
    }

    const objectName = args.object_name.toUpperCase();

    let objectUri: string;
    try {
      objectUri = `${buildObjectUri({
        name: objectName,
        type: args.object_type,
        parentName: args.parent_name,
      })}/source/main`;
    } catch (uriError: any) {
      return return_error(uriError?.message || String(uriError));
    }

    const identity = getDebuggerIdentity();
    const uri = lineBreakpointUri(objectUri, args.line);

    logger?.info(`Setting breakpoint at ${objectName}:${args.line}`);

    const { all, added } = await addBreakpoint(
      connection,
      {
        kind: 'line',
        clientId: `mcp-${objectName.toLowerCase()}-${args.line}`,
        uri,
        condition: args.condition,
      },
      logger,
    );

    // SAP echoes back the set it actually holds. If our breakpoint is not in
    // it, the position was rejected — an unreachable line, typically — and
    // saying "set" would send the caller off to wait for a listener that can
    // never fire.
    if (!added) {
      return return_error(
        new Error(
          `SAP did not register a breakpoint at ${objectName}:${args.line}. The line may not be executable — check that it is a statement, not a comment, a blank line or a declaration.`,
        ),
      );
    }

    return return_response({
      data: JSON.stringify(
        {
          success: true,
          object_name: objectName,
          line: args.line,
          breakpoint_id: added.id,
          uri: added.uri,
          condition: args.condition,
          ide_id: identity.ideId,
          total_breakpoints: all.length,
          message: `Breakpoint set at ${objectName}:${args.line}. Run DebuggerListen, then trigger the code from SAP GUI or a browser. Remove it with DebuggerDeleteBreakpoint when finished.`,
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
    logger?.error(`DebuggerSetBreakpoint failed: ${error?.message || error}`);
    return return_error(error);
  }
}
