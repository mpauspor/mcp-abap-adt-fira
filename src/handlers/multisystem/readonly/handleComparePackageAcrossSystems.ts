/**
 * ComparePackageAcrossSystems - survey a whole package across two systems.
 *
 * The custom-code question: of everything in ZMY_PACKAGE, what is already in
 * QAS, what differs, and what never left DEV? Returns a per-object verdict plus
 * a summary, and by default omits the diffs — a package-wide diff dump is
 * unreadable, and the useful first answer is the shape of the drift.
 *
 * Function groups get special treatment. A FUGR has no `/source/main` of its
 * own, so a naive filter drops it — and in ABAP custom code function groups are
 * everywhere, which would make this tool report almost nothing on a typical
 * package. Each one is therefore expanded into its function modules and its
 * includes, which do have comparable source.
 */

import {
  collectComparableUnits,
  mapLimited,
} from '../../../lib/adt/packageUnits';
import {
  getSecondaryConnection,
  normalizeForComparison,
  probeSource,
} from '../../../lib/adt/secondarySystem';
import { createAdtClient } from '../../../lib/clients';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, return_response } from '../../../lib/utils';

/** Above this the comparison turns into hundreds of round trips per system. */
const MAX_OBJECTS = 200;

/** Concurrent object comparisons. Each one costs two ADT reads. */
const CONCURRENCY = 6;

export const TOOL_DEFINITION = {
  name: 'ComparePackageAcrossSystems',
  available_in: ['onprem', 'cloud', 'legacy'] as const,
  description:
    '[read-only] Compare every source object in a package between the current system and another one, reporting which objects are identical, which differ, and which exist in only one system. This is the custom-code drift survey across a landscape (DEV vs QAS vs PRD). Function groups are expanded into their function modules and includes. Diffs are omitted by default — use CompareObjectAcrossSystems on the objects that differ.',
  inputSchema: {
    type: 'object',
    properties: {
      package_name: {
        type: 'string',
        description: 'ABAP package, e.g. ZMY_PACKAGE.',
      },
      target_system: {
        type: 'string',
        description:
          'Name of the system to compare against (from ListSystems), e.g. qs4.',
      },
      include_subpackages: {
        type: 'boolean',
        description: 'Include sub-packages. Default false.',
      },
      only_differences: {
        type: 'boolean',
        description:
          'Return only the objects that are not identical. Default true — the identical ones are rarely what you are looking for.',
      },
      max_objects: {
        type: 'number',
        description: `Safety cap on objects compared (default and maximum ${MAX_OBJECTS}). Objects beyond the cap are listed as skipped, never silently dropped.`,
      },
    },
    required: ['package_name', 'target_system'],
  },
} as const;

interface ComparePackageArgs {
  package_name: string;
  target_system: string;
  include_subpackages?: boolean;
  only_differences?: boolean;
  max_objects?: number;
}

export async function handleComparePackageAcrossSystems(
  context: HandlerContext,
  args: ComparePackageArgs,
) {
  const { connection, logger } = context;
  try {
    if (!args?.package_name || !args?.target_system) {
      return return_error('package_name and target_system are required');
    }

    const packageName = args.package_name.toUpperCase();

    let targetConnection: typeof connection;
    try {
      targetConnection = getSecondaryConnection(args.target_system, logger);
    } catch (connectError: any) {
      return return_error(connectError?.message || String(connectError));
    }

    // The package listing comes from the CURRENT system: the question is what
    // of our development has arrived elsewhere, so this side defines the set.
    const utils = createAdtClient(connection, logger).getUtils();
    const { units, notComparable, objectCount } = await collectComparableUnits(
      utils as any,
      packageName,
      { includeSubpackages: args.include_subpackages === true },
    );

    const cap = Math.min(
      MAX_OBJECTS,
      typeof args.max_objects === 'number' && args.max_objects > 0
        ? Math.trunc(args.max_objects)
        : MAX_OBJECTS,
    );
    const selected = units.slice(0, cap);
    const skippedForCap = units
      .slice(cap)
      .map((unit) => `${unit.name} (${unit.type})`);

    logger?.info(
      `ComparePackageAcrossSystems: ${selected.length} unit(s) of ${packageName} vs ${args.target_system}`,
    );

    const compared = await mapLimited(selected, CONCURRENCY, async (unit) => {
      const [here, there] = await Promise.all([
        probeSource(connection, unit.url),
        probeSource(targetConnection, unit.url),
      ]);

      const base = { name: unit.name, type: unit.type, parent: unit.parent };

      if (here.found && there.found) {
        const identical =
          normalizeForComparison(here.source ?? '') ===
          normalizeForComparison(there.source ?? '');
        return {
          ...base,
          verdict: identical ? ('identical' as const) : ('different' as const),
          source_bytes: here.source?.length,
          target_bytes: there.source?.length,
        };
      }
      if (here.found && !there.found) {
        return {
          ...base,
          verdict: there.reason?.includes('not found')
            ? ('only_in_source' as const)
            : ('unreadable' as const),
          detail: there.reason,
        };
      }
      if (!here.found && there.found) {
        return {
          ...base,
          verdict: here.reason?.includes('not found')
            ? ('only_in_target' as const)
            : ('unreadable' as const),
          detail: here.reason,
        };
      }
      return {
        ...base,
        verdict: 'unreadable' as const,
        detail: `${here.reason} / ${there.reason}`,
      };
    });

    const summary = compared.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.verdict] = (acc[entry.verdict] ?? 0) + 1;
      return acc;
    }, {});

    const onlyDifferences = args.only_differences !== false;
    const reported = onlyDifferences
      ? compared.filter((entry) => entry.verdict !== 'identical')
      : compared;

    return return_response({
      data: JSON.stringify(
        {
          success: true,
          package_name: packageName,
          source_system: '(current)',
          target_system: args.target_system,
          objects_in_package: objectCount,
          units_compared: selected.length,
          summary,
          in_sync:
            (summary.different ?? 0) === 0 &&
            (summary.only_in_source ?? 0) === 0 &&
            (summary.unreadable ?? 0) === 0,
          objects: reported,
          omitted_identical: onlyDifferences
            ? (summary.identical ?? 0)
            : undefined,
          not_comparable: notComparable.length > 0 ? notComparable : undefined,
          skipped_over_cap:
            skippedForCap.length > 0 ? skippedForCap : undefined,
          hint:
            (summary.different ?? 0) > 0
              ? 'Use CompareObjectAcrossSystems on a differing object to see the diff.'
              : undefined,
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
      `ComparePackageAcrossSystems failed: ${error?.message || error}`,
    );
    return return_error(error);
  }
}
