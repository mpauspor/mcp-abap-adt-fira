/**
 * CheckTransport — what to look at before releasing.
 *
 * The fork could already create and release transports. This answers the
 * question asked between those two: am I about to break the downstream system?
 *
 * Blockers are things SAP or the landscape will punish — an empty request, no
 * target system, tasks still open. The warning that matters most is an object
 * that also sits in somebody else's open request, because releasing this one
 * alone sends a partial version onward, and nothing about the release itself
 * says so.
 */

import {
  analyseTransport,
  gatherTransportData,
} from '../../../lib/adt/transportCheck';
import { createAdtClient } from '../../../lib/clients';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error } from '../../../lib/utils';
import { parseSqlQueryXml } from '../../system/readonly/handleGetSqlQuery';

export const TOOL_DEFINITION = {
  name: 'CheckTransport',
  description:
    '[read-only] Inspect a transport request before releasing it, and report what would go wrong. Blockers: the request does not exist, holds no objects, has no target system (so it releases and arrives nowhere), or still has open tasks, which SAP refuses to release past. Warning: objects that also sit in another open request, where releasing this one alone moves a partial version. Reads the transport tables; it never modifies or releases anything.',
  inputSchema: {
    type: 'object',
    properties: {
      transport_request: {
        type: 'string',
        description: 'Transport request to inspect, e.g. DEVK900123.',
      },
      max_objects: {
        type: 'number',
        description:
          'Cap on objects read from the request, default 2000. A larger transport is truncated rather than refused, and the result says so.',
      },
      to_file: { type: 'string' },
      overwrite: { type: 'boolean' },
    },
    required: ['transport_request'],
  },
};

interface CheckTransportArgs {
  transport_request?: string;
  max_objects?: number;
}

export async function handleCheckTransport(
  context: HandlerContext,
  args: CheckTransportArgs,
) {
  const { connection, logger } = context;

  try {
    const transport = String(args?.transport_request ?? '')
      .trim()
      .toUpperCase();
    if (!transport) {
      return return_error(new Error('transport_request is required.'));
    }

    const client = createAdtClient(connection, logger);

    // Same path as GetSqlQuery, so the transport tables are read exactly the
    // way every other query in this server is.
    const readRows = async (sql: string, maxRows: number) => {
      const response = await client
        .getUtils()
        .getSqlQuery({ sql_query: sql, row_number: maxRows });
      if (response.status !== 200 || !response.data) {
        throw new Error(
          `Reading the transport tables failed with status ${response.status}.`,
        );
      }
      return parseSqlQueryXml(response.data, sql, maxRows, logger)
        .rows as Array<Record<string, string>>;
    };

    const maxObjects = args.max_objects ?? 2000;
    const data = await gatherTransportData(readRows, transport, { maxObjects });
    const analysis = analyseTransport(transport, data);

    const blockers = analysis.findings.filter((f) => f.severity === 'blocker');
    const warnings = analysis.findings.filter((f) => f.severity === 'warning');

    const notes: string[] = [];
    if (analysis.objectCount >= maxObjects) {
      // Silence here would understate the cross-request check, which only
      // covers the objects that were read.
      notes.push(
        `The request holds at least ${maxObjects} objects and was truncated at that cap, so objects beyond it were not checked. Raise max_objects for a complete answer.`,
      );
    }

    logger?.info?.(
      `[transport-check] ${transport}: ${blockers.length} blockers, ${warnings.length} warnings`,
    );

    return {
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              transport,
              found: analysis.found,
              releasable: analysis.releasable,
              summary: {
                blockers: blockers.length,
                warnings: warnings.length,
                objects: analysis.objectCount,
                tasks: analysis.taskCount,
                open_tasks: analysis.openTaskCount,
              },
              ...(analysis.header
                ? {
                    header: {
                      owner: analysis.header.owner,
                      target: analysis.header.target || null,
                      status: analysis.header.status,
                      function: analysis.header.function,
                    },
                  }
                : {}),
              findings: analysis.findings,
              ...(notes.length ? { notes } : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (error: any) {
    logger?.error?.(`[transport-check] failed: ${error?.message}`);
    return return_error(error);
  }
}
