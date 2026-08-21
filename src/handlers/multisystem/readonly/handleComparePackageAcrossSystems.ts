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

import { buildObjectUri } from '../../../lib/adt/objectUri';
import {
  getSecondaryConnection,
  normalizeForComparison,
  probeSource,
} from '../../../lib/adt/secondarySystem';
import { createAdtClient } from '../../../lib/clients';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import {
  encodeSapObjectName,
  return_error,
  return_response,
} from '../../../lib/utils';

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

/** A single thing that can be diffed, with the URL its source lives at. */
interface ComparableUnit {
  name: string;
  type: string;
  /** Owning function group, when this unit came from expanding one. */
  parent?: string;
  url: string;
}

/** Object types whose content lives directly at `/source/main`. */
const DIRECT_SOURCE_TYPES = new Set([
  'CLAS/OC',
  'CLAS',
  'INTF/OI',
  'INTF',
  'PROG/P',
  'PROG',
  'PROG/I',
  'INCL',
  'DDLS/DF',
  'DDLS',
  'TABL/DT',
  'TABL',
  // A package lists structures as TABL/DS, not STRU/DS. Omitting it skipped
  // 165 structures in ZSD alone — they read fine from /ddic/structures/.
  'TABL/DS',
  'STRU/DS',
  'STRU',
  'BDEF/BDO',
  'BDEF',
  'SRVD/SRV',
  'SRVD',
  'DDLX/EX',
  'DDLX',
]);

const FUNCTION_GROUP_TYPES = new Set(['FUGR/F', 'FUGR', 'FUNC']);

const lower = (value: string) => encodeSapObjectName(value).toLowerCase();

/** Run over `items` with bounded concurrency, preserving order. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await fn(items[index]);
      }
    },
  );

  await Promise.all(workers);
  return results;
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
    const client = createAdtClient(connection, logger);
    const utils = client.getUtils();
    const rawItems: any[] = await utils.getPackageContentsList(packageName, {
      includeSubpackages: args.include_subpackages === true,
    });
    const items = Array.isArray(rawItems) ? rawItems : [];

    const units: ComparableUnit[] = [];
    const notComparable: Array<{ name: string; type: string }> = [];

    for (const item of items) {
      const name = String(
        item?.name ?? item?.OBJECT_NAME ?? item?.objectName ?? '',
      ).toUpperCase();
      const type = String(
        item?.type ?? item?.OBJECT_TYPE ?? item?.objectType ?? '',
      );
      if (!name) continue;

      if (DIRECT_SOURCE_TYPES.has(type)) {
        try {
          units.push({
            name,
            type,
            url: `${buildObjectUri({ name, type })}/source/main`,
          });
        } catch {
          notComparable.push({ name, type });
        }
        continue;
      }

      if (FUNCTION_GROUP_TYPES.has(type)) {
        // Expand: the group itself has no source, its modules and includes do.
        try {
          const [modules, includes] = await Promise.all([
            utils.listFunctionModules(name).catch(() => [] as string[]),
            utils.listFunctionGroupIncludes(name).catch(() => [] as string[]),
          ]);

          for (const fm of modules as string[]) {
            units.push({
              name: String(fm).toUpperCase(),
              type: 'FUGR/FF',
              parent: name,
              url: `/sap/bc/adt/functions/groups/${lower(name)}/fmodules/${lower(String(fm))}/source/main`,
            });
          }
          for (const include of includes as string[]) {
            units.push({
              name: String(include).toUpperCase(),
              type: 'FUGR/I',
              parent: name,
              url: `/sap/bc/adt/functions/groups/${lower(name)}/includes/${lower(String(include))}/source/main`,
            });
          }

          if (
            (modules as string[]).length === 0 &&
            (includes as string[]).length === 0
          ) {
            notComparable.push({ name, type });
          }
        } catch {
          notComparable.push({ name, type });
        }
        continue;
      }

      notComparable.push({ name, type });
    }

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
          objects_in_package: items.length,
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
