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
  isArray: (name) => name === 'breakpoint' || name === 'stackEntry',
});

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
