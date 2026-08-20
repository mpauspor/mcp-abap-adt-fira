/**
 * DebuggerGetVariable - read a variable's value from the attached debuggee.
 *
 * Internal tables can be huge, so the JSON form takes an offset/length window
 * rather than serialising the whole table into the tool result.
 */

import { AbapDebugger } from '@mcp-abap-adt/adt-clients';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, return_response } from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'DebuggerGetVariable',
  available_in: ['onprem'] as const,
  description:
    '[debugger] Read the value of a variable in the attached debuggee. Requires an active session from DebuggerListen. For internal tables use offset/length to page through rows instead of fetching everything.',
  inputSchema: {
    type: 'object',
    properties: {
      variable_name: {
        type: 'string',
        description: 'Variable name as written in ABAP (e.g., LT_ITEMS, GV_X).',
      },
      part: {
        type: 'string',
        description:
          "Which part of the variable to read. Use 'value' for a scalar and 'table' for an internal table. Default: 'value'.",
      },
      format: {
        type: 'string',
        enum: ['json', 'csv'],
        description:
          "Response format. 'json' (default) for structured data, 'csv' for wide internal tables.",
      },
      offset: {
        type: 'number',
        description: 'First row to read, for internal tables. Default 0.',
      },
      length: {
        type: 'number',
        description: 'Number of rows to read, for internal tables.',
      },
      filter: {
        type: 'string',
        description: 'Optional component filter.',
      },
    },
    required: ['variable_name'],
  },
} as const;

interface DebuggerGetVariableArgs {
  variable_name: string;
  part?: string;
  format?: 'json' | 'csv';
  offset?: number;
  length?: number;
  filter?: string;
}

export async function handleDebuggerGetVariable(
  context: HandlerContext,
  args: DebuggerGetVariableArgs,
) {
  const { connection, logger } = context;
  try {
    if (!args?.variable_name) {
      return return_error('variable_name is required');
    }

    const part = args.part || 'value';
    const abapDebugger = new AbapDebugger(connection, logger as any);
    const options = {
      offset: args.offset,
      length: args.length,
      filter: args.filter,
    };

    const response =
      args.format === 'csv'
        ? await abapDebugger.getVariableAsCsv(args.variable_name, part, options)
        : await abapDebugger.getVariableAsJson(
            args.variable_name,
            part,
            options,
          );

    return return_response({
      data: JSON.stringify(
        {
          success: true,
          variable_name: args.variable_name,
          part,
          format: args.format || 'json',
          value: response.data,
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
          'No debugger session is attached, or the variable is not visible in the current stack frame. Run DebuggerListen first, and check DebuggerGetStack for the active frame.',
        ),
      );
    }
    logger?.error(`DebuggerGetVariable failed: ${error?.message || error}`);
    return return_error(error);
  }
}
