/**
 * RunAtcCheck — the quality gate, on demand.
 *
 * `Check*` runs a syntax check; this runs the checks a transport is actually
 * judged by. The output leads with the shape of the problem, because a run over
 * a package returns far more findings than anyone can read: one legacy program
 * produced 35 on the system this was developed against.
 */

import {
  type AtcFinding,
  runAtcCheck,
  summariseFindings,
} from '../../../lib/adt/atc';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error } from '../../../lib/utils';

export const RunAtcCheckToolDefinition = {
  name: 'RunAtcCheck',
  description:
    '[read-only] Run ABAP Test Cockpit over an object or a whole package and return the findings, worst first. This is the check a transport is judged by — broader than the syntax check that CheckProgram and friends perform. Pass package_name to scan a package in one call, or object_name with object_type for a single object. Findings are summarised by priority and by check before the detail, since a package can produce thousands. Analyses only; it never modifies the code it inspects.',
  inputSchema: {
    type: 'object',
    properties: {
      object_name: {
        type: 'string',
        description: 'Object to check, e.g. Z_MY_REPORT.',
      },
      object_type: {
        type: 'string',
        description:
          "Type of object_name: 'PROG/P' (program), 'PROG/I' (include), 'CLAS/OC' (class), 'FUGR/F' (function group), 'TABL/DT' (table). Defaults to PROG/P.",
      },
      package_name: {
        type: 'string',
        description:
          'Package to check instead of a single object, e.g. ZSD. Scans the whole package in one run.',
      },
      check_variant: {
        type: 'string',
        description:
          'Check variant to run. Defaults to DEFAULT, the variant configured for the system. Use the same variant your transport gate uses, or the findings will not match.',
      },
      min_priority: {
        type: 'number',
        description:
          'Only report findings at this priority or worse. 1 is most severe, 3 is advisory. Use 2 to see what would realistically block a transport.',
      },
      max_findings: {
        type: 'number',
        description:
          'Cap applied by SAP during the run (maximumVerdicts), default 100. Raise it for a package.',
      },
      include_exempted: {
        type: 'boolean',
        description:
          'Include findings already exempted by an approved exemption or pseudo-comment. Off by default.',
      },
      timeout_seconds: {
        type: 'number',
        description:
          'How long to wait for the run. Default 300. A large package needs more.',
      },
      to_file: { type: 'string' },
      overwrite: { type: 'boolean' },
    },
  },
};

interface RunAtcCheckArgs {
  object_name?: string;
  object_type?: string;
  package_name?: string;
  check_variant?: string;
  min_priority?: number;
  max_findings?: number;
  include_exempted?: boolean;
  timeout_seconds?: number;
}

/** Detail lines, trimmed to what is useful to act on. */
function present(finding: AtcFinding) {
  return {
    priority: finding.priority,
    object: finding.objectName,
    // Where the problem is, which is often not the object that was scanned.
    include: finding.include,
    line: finding.line,
    check: finding.checkTitle,
    message: finding.message,
    message_id: finding.messageId,
    package: finding.packageName,
    author: finding.author,
    quickfix: finding.quickfix.automatic
      ? 'automatic'
      : finding.quickfix.manual
        ? 'manual'
        : finding.quickfix.pseudoComment
          ? 'pseudo-comment only'
          : 'none',
  };
}

export async function handleRunAtcCheck(
  context: HandlerContext,
  args: RunAtcCheckArgs,
) {
  const { connection, logger } = context;

  try {
    if (!args?.object_name && !args?.package_name) {
      return return_error(
        new Error(
          'Pass object_name (with object_type) or package_name — there is nothing to check otherwise.',
        ),
      );
    }

    const result = await runAtcCheck(connection, {
      objectName: args.object_name,
      objectType: args.object_type,
      packageName: args.package_name,
      checkVariant: args.check_variant,
      maxFindings: args.max_findings,
      timeoutSeconds: args.timeout_seconds,
    });

    let findings = result.findings;
    if (!args.include_exempted) {
      findings = findings.filter((finding) => !finding.exempted);
    }
    if (typeof args.min_priority === 'number') {
      findings = findings.filter(
        (finding) => finding.priority <= args.min_priority!,
      );
    }

    // Worst first, then group a check's findings together.
    findings = [...findings].sort(
      (a, b) =>
        a.priority - b.priority ||
        a.checkTitle.localeCompare(b.checkTitle) ||
        a.objectName.localeCompare(b.objectName) ||
        (a.line ?? 0) - (b.line ?? 0),
    );

    const notes: string[] = [];

    // ATC answers an unknown or uncheckable object with an empty worklist,
    // which is indistinguishable from clean code. Reporting "0 findings" for
    // an object that was never analysed is the kind of plausible-but-wrong
    // answer this server exists to avoid.
    if (result.objectsAnalysed === 0) {
      return return_error(
        new Error(
          `ATC analysed nothing for ${result.objectSet}. This is not a clean result: the object or package may not exist, may be outside the check variant's scope, or may have no checkable content. Verify the name and type before treating it as passing.`,
        ),
      );
    }

    if (!result.objectSetComplete) {
      // Silence here would read as a clean result.
      notes.push(
        'ATC did not analyse the whole object set — the run hit a limit. Raise max_findings, or check a smaller scope, before treating this as complete.',
      );
    }
    if (result.findings.length >= (args.max_findings ?? 100)) {
      notes.push(
        `The run stopped at the ${args.max_findings ?? 100}-finding cap, so there may be more. Raise max_findings to see the rest.`,
      );
    }

    logger?.info?.(
      `[atc] ${result.objectSet}: ${findings.length} findings reported of ${result.findings.length} returned`,
    );

    return {
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              object_set: result.objectSet,
              check_variant: result.checkVariant,
              objects_analysed: result.objectsAnalysed,
              object_set_complete: result.objectSetComplete,
              summary: summariseFindings(findings),
              findings: findings.map(present),
              ...(notes.length ? { notes } : {}),
              worklist_id: result.worklistId,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (error: any) {
    logger?.error?.(`[atc] run failed: ${error?.message}`);
    return return_error(error);
  }
}
