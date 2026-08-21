/**
 * Driving a caught debuggee: attach, stack, variables, step.
 *
 * Catching a debuggee is not enough to inspect it. The listener hands back a
 * DEBUGGEE_ID and nothing more — every later call needs the session to be
 * ATTACHED to that id first, and without it SAP answers as though no session
 * existed at all. That missing step is why `DebuggerGetStack` reported "no
 * debugger session is attached" immediately after a successful catch.
 *
 * The endpoints differ from the ones the adt-clients package uses, notably the
 * `method=` query parameter that selects the operation on `/sap/bc/adt/debugger`
 * and the SAP-specific media types the variable calls demand.
 */

import type { IAbapConnection, ILogger } from '@mcp-abap-adt/interfaces';
import { XMLParser } from 'fast-xml-parser';
import { makeAdtRequestWithTimeout } from '../utils';
import { getDebuggerUser } from './debuggerIdentity';

const DEBUGGER_URL = '/sap/bc/adt/debugger';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseAttributeValue: false,
  isArray: (name) =>
    name === 'breakpoint' ||
    name === 'stackEntry' ||
    name === 'STPDA_ADT_VARIABLE' ||
    name === 'STPDA_ADT_VARIABLE_HIERARCHY',
});

/** One ABAP variable as the debugger reports it. */
export interface DebugVariable {
  name: string;
  value?: string;
  /** Declared type, e.g. I, STRING, ZMY_STRUCTURE. */
  type?: string;
  technicalType?: string;
  length?: number;
  /** simple | structure | table | object | ... — decides whether to drill in. */
  metaType?: string;
  kind?: string;
  readOnly?: boolean;
  /** Rows, when this is an internal table. */
  tableLines?: number;
  /** SAP truncated the value; drill in for the rest. */
  incomplete?: boolean;
}

/** A node under a parent, for drilling into structures and tables. */
export interface DebugVariableChild {
  parentId: string;
  childId: string;
  childName?: string;
}

const text = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const asString = String(value);
  return asString.length > 0 ? asString : undefined;
};

function toVariable(entry: any): DebugVariable {
  const length = text(entry?.LENGTH);
  const lines = text(entry?.TABLE_LINES);
  return {
    name: String(entry?.NAME ?? entry?.ID ?? ''),
    // ABAP pads fixed-width values; the padding is not part of the value.
    value: text(entry?.VALUE)?.replace(/\s+$/, ''),
    type: text(entry?.DECLARED_TYPE_NAME) ?? text(entry?.ACTUAL_TYPE_NAME),
    technicalType: text(entry?.TECHNICAL_TYPE),
    length: length ? Number.parseInt(length, 10) : undefined,
    metaType: text(entry?.META_TYPE),
    kind: text(entry?.KIND),
    // SAP encodes these flags as empty elements: present-but-empty is false.
    readOnly: text(entry?.READ_ONLY) !== undefined,
    tableLines: lines ? Number.parseInt(lines, 10) : undefined,
    incomplete: text(entry?.IS_VALUE_INCOMPLETE) !== undefined,
  };
}

/**
 * Parse the `asx:abap` envelope the variable calls return.
 *
 * Returning the raw XML made the caller do this work, and a model reading
 * eighty ALL-CAPS elements per variable spends context on padding rather than
 * on values.
 */
export function parseVariables(xml: string): {
  variables: DebugVariable[];
  children: DebugVariableChild[];
} {
  if (!xml || !xml.includes('STPDA')) return { variables: [], children: [] };

  let data: any;
  try {
    data = parser.parse(xml)?.abap?.values?.DATA;
  } catch {
    return { variables: [], children: [] };
  }

  const rawVariables = Array.isArray(data?.STPDA_ADT_VARIABLE)
    ? data.STPDA_ADT_VARIABLE
    : Array.isArray(data?.VARIABLES?.STPDA_ADT_VARIABLE)
      ? data.VARIABLES.STPDA_ADT_VARIABLE
      : [];

  const rawChildren = Array.isArray(
    data?.HIERARCHIES?.STPDA_ADT_VARIABLE_HIERARCHY,
  )
    ? data.HIERARCHIES.STPDA_ADT_VARIABLE_HIERARCHY
    : [];

  return {
    variables: rawVariables
      .map(toVariable)
      .filter((v: DebugVariable) => v.name),
    children: rawChildren.map((entry: any) => ({
      parentId: String(entry?.PARENT_ID ?? ''),
      childId: String(entry?.CHILD_ID ?? ''),
      childName: text(entry?.CHILD_NAME),
    })),
  };
}

/** Steps SAP accepts. `stepContinue` runs to the next breakpoint. */
export type DebugStep =
  | 'stepInto'
  | 'stepOver'
  | 'stepReturn'
  | 'stepContinue'
  | 'terminateDebuggee'
  | 'detachDebugger';

export interface DebuggeeInfo {
  debuggeeId: string;
  user?: string;
  program?: string;
  include?: string;
  line?: number;
  rfcDestination?: string;
}

/**
 * Pull the debuggee out of the listener's response.
 *
 * The payload is an `asx:abap` envelope rather than an ADT resource, so the
 * fields are ALL-CAPS element names, not attributes.
 */
export function parseDebuggee(xml: string): DebuggeeInfo | undefined {
  if (!xml || !xml.includes('DEBUGGEE_ID')) return undefined;

  const value = (tag: string): string | undefined => {
    const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return match ? match[1].trim() : undefined;
  };

  const debuggeeId = value('DEBUGGEE_ID');
  if (!debuggeeId) return undefined;

  const line = value('LINE_CURR');
  return {
    debuggeeId,
    user: value('DEBUGGEE_USER'),
    program: value('PRG_CURR'),
    include: value('INCL_CURR'),
    line: line ? Number.parseInt(line, 10) : undefined,
    rfcDestination: value('RFCDEST'),
  };
}

/**
 * Attach to a caught debuggee. Every later call depends on this.
 *
 * @returns the breakpoints SAP reports as reached, which is how the caller
 *          learns WHY execution stopped.
 */
export async function attachDebuggee(
  connection: IAbapConnection,
  debuggeeId: string,
  logger?: ILogger,
): Promise<{ reachedBreakpoints: any[]; raw: string }> {
  const query = new URLSearchParams({
    method: 'attach',
    debuggeeId,
    dynproDebugging: 'true',
    debuggingMode: 'user',
    requestUser: getDebuggerUser() ?? '',
  });

  logger?.info(`Attaching to debuggee ${debuggeeId}`);

  const response = await makeAdtRequestWithTimeout(
    connection,
    `${DEBUGGER_URL}?${query.toString()}`,
    'POST',
    'default',
    null,
    undefined,
    { Accept: 'application/xml' },
  );

  const raw = typeof response.data === 'string' ? response.data : '';
  let reachedBreakpoints: any[] = [];
  try {
    const parsed = parser.parse(raw);
    const entries = parsed?.attach?.reachedBreakpoints?.breakpoint;
    reachedBreakpoints = Array.isArray(entries) ? entries : [];
  } catch {
    /* the attach still counts; only the reason list is lost */
  }

  return { reachedBreakpoints, raw };
}

/** Read the call stack of the attached debuggee. */
export async function getStack(connection: IAbapConnection): Promise<string> {
  const query = new URLSearchParams({
    method: 'getStack',
    emode: '_',
    semanticURIs: 'true',
  });

  const response = await makeAdtRequestWithTimeout(
    connection,
    `/sap/bc/adt/debugger/stack?${query.toString()}`,
    'GET',
    'default',
    undefined,
    undefined,
    { Accept: 'application/xml' },
  );
  return typeof response.data === 'string' ? response.data : '';
}

/**
 * Read variables by name.
 *
 * These two calls insist on a SAP-specific media type; `application/xml` is
 * refused with a 406.
 */
export async function getVariables(
  connection: IAbapConnection,
  names: string[],
): Promise<string> {
  const body = `<?xml version="1.0" encoding="UTF-8" ?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values>
<DATA>${names
    .map((name) => `<STPDA_ADT_VARIABLE><ID>${name}</ID></STPDA_ADT_VARIABLE>`)
    .join('')}</DATA></asx:values></asx:abap>`;

  const response = await makeAdtRequestWithTimeout(
    connection,
    `${DEBUGGER_URL}?method=getVariables`,
    'POST',
    'default',
    body,
    undefined,
    {
      Accept:
        'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.debugger.Variables',
      'Content-Type':
        'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.debugger.Variables',
    },
  );
  return typeof response.data === 'string' ? response.data : '';
}

/** List the variables visible in the current frame. */
export async function getChildVariables(
  connection: IAbapConnection,
  parents: string[] = ['@ROOT'],
): Promise<string> {
  const body = `<?xml version="1.0" encoding="UTF-8" ?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values>
<DATA><HIERARCHIES>${parents
    .map(
      (parent) =>
        `<STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>${parent}</PARENT_ID></STPDA_ADT_VARIABLE_HIERARCHY>`,
    )
    .join('')}</HIERARCHIES></DATA></asx:values></asx:abap>`;

  const response = await makeAdtRequestWithTimeout(
    connection,
    `${DEBUGGER_URL}?method=getChildVariables`,
    'POST',
    'default',
    body,
    undefined,
    {
      Accept:
        'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.debugger.ChildVariables',
      'Content-Type':
        'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.debugger.ChildVariables',
    },
  );
  return typeof response.data === 'string' ? response.data : '';
}

/** Advance the attached debuggee. */
export async function step(
  connection: IAbapConnection,
  action: DebugStep,
  logger?: ILogger,
): Promise<string> {
  logger?.debug(`Debugger step: ${action}`);

  const response = await makeAdtRequestWithTimeout(
    connection,
    `${DEBUGGER_URL}?method=${encodeURIComponent(action)}`,
    'POST',
    'long',
    null,
    undefined,
    { Accept: 'application/xml' },
  );
  return typeof response.data === 'string' ? response.data : '';
}
