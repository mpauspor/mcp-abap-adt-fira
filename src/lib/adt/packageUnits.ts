/**
 * Turning a package listing into things that can actually be diffed.
 *
 * Shared by the two-system and landscape-wide comparison tools so the notion of
 * "comparable" cannot drift between them.
 *
 * Two traps are encoded here, both found by probing a live system rather than by reading
 * documentation:
 *
 * 1. A package lists structures as `TABL/DS`, not `STRU/DS`. Missing that entry
 *    silently skipped 165 structures in ZSD alone.
 * 2. A function group has no `/source/main` of its own. Left unexpanded it is
 *    dropped, and since function groups are everywhere in ABAP custom code, a
 *    typical package would report almost nothing. Each is expanded into its
 *    function modules and its includes, which do have source.
 *
 * Confirmed NOT readable this way, and therefore correctly skipped: `VIEW/DV`
 * and `TTYP/DA` both 404 at their DDIC source endpoints.
 */

import { encodeSapObjectName } from '../utils';
import { buildObjectUri } from './objectUri';

/** A single thing that can be diffed, with the URL its source lives at. */
export interface ComparableUnit {
  name: string;
  type: string;
  /** Owning function group, when this unit came from expanding one. */
  parent?: string;
  url: string;
}

export interface PackageUnits {
  units: ComparableUnit[];
  /** Objects with no comparable source, reported rather than silently dropped. */
  notComparable: Array<{ name: string; type: string }>;
  /** Raw object count as the package reported it. */
  objectCount: number;
}

/** Object types whose content lives directly at `/source/main`. */
export const DIRECT_SOURCE_TYPES = new Set([
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
  // A package lists structures as TABL/DS, not STRU/DS.
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

/** The subset of AdtUtils this module needs, so callers can pass any client. */
export interface PackageReader {
  getPackageContentsList(
    packageName: string,
    options?: { includeSubpackages?: boolean },
  ): Promise<any[]>;
  listFunctionModules(functionGroup: string): Promise<string[]>;
  listFunctionGroupIncludes(functionGroup: string): Promise<string[]>;
}

/**
 * Expand a package into comparable units.
 *
 * @param typeFilter When given, only these object types are considered. Applied
 *        to the type as the PACKAGE reports it, so pass e.g. `TABL/DS` for
 *        structures and `FUGR/F` to pull in a group's modules and includes.
 */
export async function collectComparableUnits(
  reader: PackageReader,
  packageName: string,
  options?: {
    includeSubpackages?: boolean;
    typeFilter?: Set<string>;
    /** Parallel function-group expansions. */
    expansionConcurrency?: number;
  },
): Promise<PackageUnits> {
  const raw = await reader.getPackageContentsList(packageName, {
    includeSubpackages: options?.includeSubpackages === true,
  });
  const items = Array.isArray(raw) ? raw : [];

  const notComparable: Array<{ name: string; type: string }> = [];

  // Classify first, expand second. Expanding inline would serialise a round
  // trip per function group before any comparison starts — measured as the
  // dominant cost on a package with many groups, dwarfing the comparisons
  // themselves.
  type Slot =
    | { kind: 'direct'; unit: ComparableUnit }
    | { kind: 'group'; name: string; type: string };
  const slots: Slot[] = [];

  for (const item of items) {
    const name = String(
      item?.name ?? item?.OBJECT_NAME ?? item?.objectName ?? '',
    ).toUpperCase();
    const type = String(
      item?.type ?? item?.OBJECT_TYPE ?? item?.objectType ?? '',
    );
    if (!name) continue;

    if (options?.typeFilter && !options.typeFilter.has(type)) continue;

    if (DIRECT_SOURCE_TYPES.has(type)) {
      try {
        slots.push({
          kind: 'direct',
          unit: {
            name,
            type,
            url: `${buildObjectUri({ name, type })}/source/main`,
          },
        });
      } catch {
        notComparable.push({ name, type });
      }
      continue;
    }

    if (FUNCTION_GROUP_TYPES.has(type)) {
      slots.push({ kind: 'group', name, type });
      continue;
    }

    notComparable.push({ name, type });
  }

  const groups = slots.filter((slot) => slot.kind === 'group') as Array<{
    kind: 'group';
    name: string;
    type: string;
  }>;

  const expanded = new Map<string, ComparableUnit[]>();
  await mapLimited(
    groups,
    options?.expansionConcurrency ?? 8,
    async (group) => {
      const [modules, includes] = await Promise.all([
        reader.listFunctionModules(group.name).catch(() => [] as string[]),
        reader
          .listFunctionGroupIncludes(group.name)
          .catch(() => [] as string[]),
      ]);

      const produced: ComparableUnit[] = [
        ...modules.map((fm) => ({
          name: String(fm).toUpperCase(),
          type: 'FUGR/FF',
          parent: group.name,
          url: `/sap/bc/adt/functions/groups/${lower(group.name)}/fmodules/${lower(String(fm))}/source/main`,
        })),
        ...includes.map((include) => ({
          name: String(include).toUpperCase(),
          type: 'FUGR/I',
          parent: group.name,
          url: `/sap/bc/adt/functions/groups/${lower(group.name)}/includes/${lower(String(include))}/source/main`,
        })),
      ];

      expanded.set(group.name, produced);
      if (produced.length === 0) {
        notComparable.push({ name: group.name, type: group.type });
      }
    },
  );

  // Reassemble in package order.
  const units: ComparableUnit[] = [];
  for (const slot of slots) {
    if (slot.kind === 'direct') {
      units.push(slot.unit);
    } else {
      units.push(...(expanded.get(slot.name) ?? []));
    }
  }

  return { units, notComparable, objectCount: items.length };
}

/** Run over `items` with bounded concurrency, preserving order. */
export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
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
