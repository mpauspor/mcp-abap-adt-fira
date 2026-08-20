/**
 * CompareObjectAcrossSystems - diff one object's source between two systems.
 *
 * A note on what is compared, and why. ABAP version NUMBERS are local to each
 * system: version 7 in DEV and version 7 in QAS are unrelated counters, so
 * comparing them tells you nothing. What is comparable is the SOURCE, and that
 * is what this does.
 */

import { createTwoFilesPatch } from 'diff';
import { buildObjectUri } from '../../../lib/adt/objectUri';
import {
  getSecondaryConnection,
  normalizeForComparison,
  probeSource,
} from '../../../lib/adt/secondarySystem';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, return_response } from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'CompareObjectAcrossSystems',
  available_in: ['onprem', 'cloud', 'legacy'] as const,
  description:
    '[read-only] Compare one repository object\'s source between the current system and another one (or between two named systems), returning a unified diff. Answers "is this object the same in QAS as in DEV?" and "has it reached PRD yet?". Note that ABAP version numbers are per-system counters and are NOT comparable — this compares source. Use ListSystems for the available names.',
  inputSchema: {
    type: 'object',
    properties: {
      object_name: {
        type: 'string',
        description: 'Object name, e.g. ZCL_MY_CLASS.',
      },
      object_type: {
        type: 'string',
        description:
          'Object type code: CLAS/OC, INTF/OI, PROG/P, PROG/I (include), DDLS/DF, TABL, STRU, BDEF, SRVD, DDLX, FUGR/FF.',
      },
      target_system: {
        type: 'string',
        description:
          'Name of the system to compare against (from ListSystems), e.g. qs4.',
      },
      source_system: {
        type: 'string',
        description:
          'Optional. Name of the system to compare FROM. Defaults to the system this server is connected to.',
      },
      parent_name: {
        type: 'string',
        description: 'Function group, required for function modules (FUGR/FF).',
      },
      include_diff: {
        type: 'boolean',
        description:
          'Include the unified diff text. Default true. Set false for a verdict only, when scanning many objects.',
      },
      context_lines: {
        type: 'number',
        description: 'Context lines around each change. Default 3.',
      },
    },
    required: ['object_name', 'object_type', 'target_system'],
  },
} as const;

interface CompareObjectArgs {
  object_name: string;
  object_type: string;
  target_system: string;
  source_system?: string;
  parent_name?: string;
  include_diff?: boolean;
  context_lines?: number;
}

export async function handleCompareObjectAcrossSystems(
  context: HandlerContext,
  args: CompareObjectArgs,
) {
  const { connection, logger } = context;
  try {
    if (!args?.object_name || !args?.object_type || !args?.target_system) {
      return return_error(
        'object_name, object_type and target_system are required',
      );
    }

    const objectName = args.object_name.toUpperCase();

    let sourceUrl: string;
    try {
      sourceUrl = `${buildObjectUri({
        name: objectName,
        type: args.object_type,
        parentName: args.parent_name,
      })}/source/main`;
    } catch (uriError: any) {
      return return_error(uriError?.message || String(uriError));
    }

    const sourceLabel = args.source_system ?? '(current)';
    const targetLabel = args.target_system;

    let sourceConnection = connection;
    try {
      if (args.source_system) {
        sourceConnection = getSecondaryConnection(args.source_system, logger);
      }
    } catch (connectError: any) {
      return return_error(connectError?.message || String(connectError));
    }

    let targetConnection: typeof connection;
    try {
      targetConnection = getSecondaryConnection(args.target_system, logger);
    } catch (connectError: any) {
      return return_error(connectError?.message || String(connectError));
    }

    logger?.info(
      `Comparing ${objectName} (${args.object_type}) between ${sourceLabel} and ${targetLabel}`,
    );

    // Both reads run concurrently — they are independent systems.
    const [inSource, inTarget] = await Promise.all([
      probeSource(sourceConnection, sourceUrl),
      probeSource(targetConnection, sourceUrl),
    ]);

    // Absence is a result, not an error: "not in QAS yet" is exactly what the
    // caller is often asking about.
    let verdict:
      | 'identical'
      | 'different'
      | 'only_in_source'
      | 'only_in_target'
      | 'missing_in_both'
      | 'unreadable';

    if (!inSource.found && !inTarget.found) {
      verdict =
        inSource.reason?.includes('not found') &&
        inTarget.reason?.includes('not found')
          ? 'missing_in_both'
          : 'unreadable';
    } else if (inSource.found && !inTarget.found) {
      verdict = inTarget.reason?.includes('not found')
        ? 'only_in_source'
        : 'unreadable';
    } else if (!inSource.found && inTarget.found) {
      verdict = inSource.reason?.includes('not found')
        ? 'only_in_target'
        : 'unreadable';
    } else {
      verdict =
        normalizeForComparison(inSource.source ?? '') ===
        normalizeForComparison(inTarget.source ?? '')
          ? 'identical'
          : 'different';
    }

    const wantDiff = args.include_diff !== false && verdict === 'different';
    const diff = wantDiff
      ? createTwoFilesPatch(
          `${sourceLabel}/${objectName}`,
          `${targetLabel}/${objectName}`,
          inSource.source ?? '',
          inTarget.source ?? '',
          undefined,
          undefined,
          {
            context:
              typeof args.context_lines === 'number'
                ? Math.max(0, Math.trunc(args.context_lines))
                : 3,
          },
        )
      : undefined;

    const messages: Record<string, string> = {
      identical: `${objectName} is identical in ${sourceLabel} and ${targetLabel}.`,
      different: `${objectName} DIFFERS between ${sourceLabel} and ${targetLabel}.`,
      only_in_source: `${objectName} exists in ${sourceLabel} but NOT in ${targetLabel} — it has not been transported yet.`,
      only_in_target: `${objectName} exists in ${targetLabel} but NOT in ${sourceLabel}.`,
      missing_in_both: `${objectName} does not exist in either system.`,
      unreadable: `${objectName} could not be compared — see source_status/target_status.`,
    };

    return return_response({
      data: JSON.stringify(
        {
          success: verdict !== 'unreadable',
          object_name: objectName,
          object_type: args.object_type,
          source_system: sourceLabel,
          target_system: targetLabel,
          verdict,
          identical: verdict === 'identical',
          source_status: inSource.found ? 'present' : inSource.reason,
          target_status: inTarget.found ? 'present' : inTarget.reason,
          source_bytes: inSource.source?.length,
          target_bytes: inTarget.source?.length,
          diff,
          message: messages[verdict],
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
      `CompareObjectAcrossSystems failed: ${error?.message || error}`,
    );
    return return_error(error);
  }
}
