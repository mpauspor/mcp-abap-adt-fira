/**
 * ComparePackageAcrossLandscape - where has each object of a package got to?
 *
 * One call walks the whole promotion chain (DEV -> QAS -> PRD) instead of
 * comparing pairs and cross-referencing the results by hand.
 *
 * The reading it produces is deliberately conservative. It reports, per object,
 * which systems match the source and which do not, and derives how far the
 * object has travelled — but it flags rather than smooths over the case where a
 * LATER system matches while an EARLIER one does not. That pattern is not a
 * promotion state at all: it means someone changed something out of band, and
 * quietly labelling it "promoted" would hide exactly the problem worth finding.
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

/** Above this the sweep costs more round trips than anyone will wait for. */
const MAX_OBJECTS = 400;
const DEFAULT_MAX_OBJECTS = 150;
const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 16;

export const TOOL_DEFINITION = {
  name: 'ComparePackageAcrossLandscape',
  available_in: ['onprem', 'cloud', 'legacy'] as const,
  description:
    '[read-only] Walk a package across an ordered promotion chain (e.g. QAS then PRD) in ONE call and report how far each object has travelled from the current system. Use instead of running CompareObjectAcrossSystems per system and cross-referencing by hand. Flags out-of-band changes, where a downstream system matches while an upstream one does not. Function groups are expanded into modules and includes; use object_types to narrow a large package.',
  inputSchema: {
    type: 'object',
    properties: {
      package_name: {
        type: 'string',
        description: 'ABAP package, e.g. ZSD.',
      },
      systems: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Target systems IN PROMOTION ORDER, e.g. ["qs4","ps4"]. Names come from ListSystems. The current system is always the source.',
      },
      object_types: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional filter on the type as the PACKAGE reports it, e.g. ["CLAS/OC","PROG/P","TABL/DS","FUGR/F"]. Strongly recommended on large packages.',
      },
      include_subpackages: {
        type: 'boolean',
        description: 'Include sub-packages. Default false.',
      },
      only_pending: {
        type: 'boolean',
        description:
          'Return only objects that have NOT reached the end of the chain. Default true.',
      },
      max_objects: {
        type: 'number',
        description: `Safety cap on units compared (default ${DEFAULT_MAX_OBJECTS}, maximum ${MAX_OBJECTS}). Anything beyond is reported as skipped, never silently dropped.`,
      },
      concurrency: {
        type: 'number',
        description: `Parallel object comparisons (default ${DEFAULT_CONCURRENCY}, maximum ${MAX_CONCURRENCY}). Each one costs one read per system, so raising this multiplies load on every system in the chain.`,
      },
    },
    required: ['package_name', 'systems'],
  },
} as const;

interface LandscapeArgs {
  package_name: string;
  systems: string[];
  object_types?: string[];
  include_subpackages?: boolean;
  only_pending?: boolean;
  max_objects?: number;
  concurrency?: number;
}

type SystemVerdict = 'identical' | 'different' | 'missing' | 'unreadable';

function clamp(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && value > 0
    ? Math.min(max, Math.trunc(value))
    : fallback;
}

export async function handleComparePackageAcrossLandscape(
  context: HandlerContext,
  args: LandscapeArgs,
) {
  const { connection, logger } = context;
  try {
    if (!args?.package_name || !Array.isArray(args?.systems)) {
      return return_error('package_name and systems (an array) are required');
    }

    const systemNames = args.systems
      .map((name) => String(name).trim())
      .filter(Boolean);
    if (systemNames.length === 0) {
      return return_error(
        'systems must name at least one target system. Use ListSystems to see the available names.',
      );
    }

    // Open every connection before doing any work: an unreachable system should
    // fail immediately, not after several minutes of comparing.
    const targets: Array<{ name: string; connection: typeof connection }> = [];
    for (const name of systemNames) {
      try {
        targets.push({
          name,
          connection: getSecondaryConnection(name, logger),
        });
      } catch (connectError: any) {
        return return_error(connectError?.message || String(connectError));
      }
    }

    const packageName = args.package_name.toUpperCase();
    const utils = createAdtClient(connection, logger).getUtils();

    const { units, notComparable, objectCount } = await collectComparableUnits(
      utils as any,
      packageName,
      {
        includeSubpackages: args.include_subpackages === true,
        typeFilter:
          args.object_types && args.object_types.length > 0
            ? new Set(args.object_types)
            : undefined,
      },
    );

    const cap = clamp(args.max_objects, DEFAULT_MAX_OBJECTS, MAX_OBJECTS);
    const selected = units.slice(0, cap);
    const skippedForCap = units.slice(cap);

    const concurrency = clamp(
      args.concurrency,
      DEFAULT_CONCURRENCY,
      MAX_CONCURRENCY,
    );

    logger?.info(
      `Landscape sweep: ${packageName}, ${selected.length} unit(s) x ${targets.length + 1} system(s), concurrency ${concurrency}`,
    );

    const rows = await mapLimited(selected, concurrency, async (unit) => {
      // Source and every target read in parallel for this unit.
      const [source, ...targetProbes] = await Promise.all([
        probeSource(connection, unit.url),
        ...targets.map((target) => probeSource(target.connection, unit.url)),
      ]);

      const perSystem: Record<string, SystemVerdict> = {};
      const normalizedSource = source.found
        ? normalizeForComparison(source.source ?? '')
        : undefined;

      targets.forEach((target, index) => {
        const probe = targetProbes[index];
        if (!probe.found) {
          perSystem[target.name] = probe.reason?.includes('not found')
            ? 'missing'
            : 'unreadable';
          return;
        }
        if (normalizedSource === undefined) {
          // Present downstream but not in the source system.
          perSystem[target.name] = 'unreadable';
          return;
        }
        perSystem[target.name] =
          normalizeForComparison(probe.source ?? '') === normalizedSource
            ? 'identical'
            : 'different';
      });

      const verdicts = targets.map((target) => perSystem[target.name]);
      const reached = targets
        .filter((target) => perSystem[target.name] === 'identical')
        .map((target) => target.name);

      // How far the object travelled before the chain first breaks.
      let frontier = 0;
      while (frontier < verdicts.length && verdicts[frontier] === 'identical') {
        frontier++;
      }

      // A later system matching while an earlier one does not is not a
      // promotion state — it is a change made outside the chain.
      const outOfBand =
        verdicts.slice(frontier).some((v) => v === 'identical') &&
        frontier < verdicts.length;

      let status:
        | 'promoted'
        | 'pending'
        | 'not_transported'
        | 'out_of_band'
        | 'unreadable';

      if (!source.found) {
        status = 'unreadable';
      } else if (outOfBand) {
        status = 'out_of_band';
      } else if (frontier === verdicts.length) {
        status = 'promoted';
      } else if (verdicts.every((v) => v === 'missing')) {
        status = 'not_transported';
      } else if (verdicts.some((v) => v === 'unreadable')) {
        status = 'unreadable';
      } else {
        status = 'pending';
      }

      return {
        name: unit.name,
        type: unit.type,
        parent: unit.parent,
        status,
        reached_through: frontier > 0 ? targets[frontier - 1].name : null,
        pending_from: frontier < targets.length ? targets[frontier].name : null,
        reached,
        per_system: perSystem,
        source_bytes: source.source?.length,
      };
    });

    const summary = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {});

    const onlyPending = args.only_pending !== false;
    const reported = onlyPending
      ? rows.filter((row) => row.status !== 'promoted')
      : rows;

    const outOfBand = rows.filter((row) => row.status === 'out_of_band');

    return return_response({
      data: JSON.stringify(
        {
          success: true,
          package_name: packageName,
          source_system: '(current)',
          chain: systemNames,
          objects_in_package: objectCount,
          units_compared: selected.length,
          concurrency,
          summary,
          fully_promoted: (summary.promoted ?? 0) === rows.length,
          objects: reported,
          omitted_promoted: onlyPending ? (summary.promoted ?? 0) : undefined,
          out_of_band_warning:
            outOfBand.length > 0
              ? `${outOfBand.length} object(s) match a DOWNSTREAM system while an upstream one differs. That is not a promotion state — it suggests a change applied outside the transport chain: ${outOfBand
                  .slice(0, 10)
                  .map((row) => row.name)
                  .join(', ')}`
              : undefined,
          not_comparable_count:
            notComparable.length > 0 ? notComparable.length : undefined,
          skipped_over_cap:
            skippedForCap.length > 0
              ? {
                  count: skippedForCap.length,
                  hint: 'Narrow with object_types, or raise max_objects.',
                }
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
      `ComparePackageAcrossLandscape failed: ${error?.message || error}`,
    );
    return return_error(error);
  }
}
