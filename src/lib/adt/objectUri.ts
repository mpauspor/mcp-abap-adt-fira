/**
 * ADT URI construction for repository objects.
 *
 * Replaces `buildObjectUri` from `@mcp-abap-adt/adt-clients`, which has three
 * defects that between them make include and function-module activation fail:
 *
 * 1. No case for `PROG/I`. Includes fall through to a `default:` branch that
 *    assembles `/sap/bc/adt/prog/i/<name>` from the type code — a path that
 *    does not exist. Callers who work around it by passing `PROG` instead get
 *    `/programs/programs/<name>`, and SAP rejects the include with
 *    "REPORT/PROGRAM statement is missing" because it is being activated as a
 *    report.
 * 2. The `default:` branch invents a URI from the type code rather than
 *    admitting it does not know the type, so an unsupported type produces a
 *    404 at activation time instead of a clear error at build time.
 * 3. `FUGR/FF` without a parent falls back to using the function module's own
 *    name as its function group, yielding
 *    `/functions/groups/<fm>/fmodules/<fm>`.
 */

import { encodeSapObjectName } from '../utils';

export interface ObjectUriRequest {
  name: string;
  type?: string;
  /** Explicit ADT URI. Wins over everything — the caller's escape hatch for a type this map does not know. */
  uri?: string;
  /** Function group, required for FUGR/FF. */
  parentName?: string;
}

/** type code → path segment under /sap/bc/adt/ */
const URI_BY_TYPE: Record<string, string> = {
  'CLAS/OC': 'oo/classes',
  CLAS: 'oo/classes',
  'INTF/OI': 'oo/interfaces',
  INTF: 'oo/interfaces',
  'PROG/P': 'programs/programs',
  PROG: 'programs/programs',
  // The entries the upstream builder is missing.
  'PROG/I': 'programs/includes',
  INCL: 'programs/includes',
  'FUGR/I': 'programs/includes',
  FUGR: 'functions/groups',
  'FUGR/F': 'functions/groups',
  FUNC: 'functions/groups',
  'TABL/DT': 'ddic/tables',
  TABL: 'ddic/tables',
  'TABL/DS': 'ddic/structures',
  'STRU/DS': 'ddic/structures',
  STRU: 'ddic/structures',
  'DDLS/DF': 'ddic/ddl/sources',
  DDLS: 'ddic/ddl/sources',
  'VIEW/DV': 'ddic/views',
  VIEW: 'ddic/views',
  'DTEL/DE': 'ddic/dataelements',
  DTEL: 'ddic/dataelements',
  'DOMA/DD': 'ddic/domains',
  DOMA: 'ddic/domains',
  'TTYP/DF': 'ddic/tabletypes',
  'TTYP/TT': 'ddic/tabletypes',
  TTYP: 'ddic/tabletypes',
  'SRVD/SRV': 'ddic/srvd/sources',
  SRVD: 'ddic/srvd/sources',
  'SRVB/SVB': 'businessservices/bindings',
  SRVB: 'businessservices/bindings',
  'DDLX/EX': 'ddic/ddlx/sources',
  DDLX: 'ddic/ddlx/sources',
  'BDEF/BDO': 'ddic/bdef/sources',
  BDEF: 'ddic/bdef/sources',
  'DCLS/DL': 'acm/dcl/sources',
  DCLS: 'acm/dcl/sources',
  'DSFD/SCF': 'ddic/dsfd/sources',
  'DSFI/SFI': 'ddic/dsfi',
  'ENHO/ENH': 'enhancements',
  ENHO: 'enhancements',
  MSAG: 'messageclass',
};

/** Types whose activation is driven through the include resource. */
export const INCLUDE_TYPES = new Set(['PROG/I', 'INCL', 'FUGR/I']);

export function isIncludeType(type?: string): boolean {
  return !!type && INCLUDE_TYPES.has(type.toUpperCase());
}

/**
 * Build the ADT URI for a repository object.
 *
 * @throws when the type is unknown, rather than inventing a path that will
 *         404 later. A caller who knows better can pass `uri` explicitly.
 */
export function buildObjectUri(request: ObjectUriRequest): string {
  if (request.uri) return request.uri;

  const lowerName = encodeSapObjectName(request.name).toLowerCase();
  const type = request.type?.toUpperCase();

  if (!type) {
    throw new Error(
      `Cannot build an ADT URI for "${request.name}": no object type given. Pass "type" (e.g. PROG/I, CLAS/OC) or an explicit "uri".`,
    );
  }

  // A function module is addressed beneath its function group, which cannot be
  // guessed from the module name.
  if (type === 'FUGR/FF' || type === 'FUNC/FF') {
    if (!request.parentName) {
      throw new Error(
        `Cannot build an ADT URI for function module "${request.name}": its function group is required. Pass "parent_name".`,
      );
    }
    const lowerParent = encodeSapObjectName(request.parentName).toLowerCase();
    return `/sap/bc/adt/functions/groups/${lowerParent}/fmodules/${lowerName}`;
  }

  const segment = URI_BY_TYPE[type];
  if (!segment) {
    throw new Error(
      `Unknown object type "${request.type}" for "${request.name}". Pass an explicit "uri" if you know the ADT path.`,
    );
  }

  return `/sap/bc/adt/${segment}/${lowerName}`;
}
