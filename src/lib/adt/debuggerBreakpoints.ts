/**
 * External ABAP breakpoints over ADT.
 *
 * Needed because a breakpoint set in SAP GUI is a SESSION breakpoint: it opens
 * the classic GUI debugger and is invisible to an ADT listener. Verified on a
 * 7.5x system — after setting one in SE38, `GET /sap/bc/adt/debugger/breakpoints`
 * returned empty. Only a breakpoint registered through ADT, under the same
 * ideId as the listener, can be caught by `DebuggerListen`.
 *
 * The payload shape was not documented anywhere reachable. It was recovered by
 * probing a live system — a wrong root element makes SAP name the expected one, and a
 * missing attribute is named too — and finished against the open-source
 * `abap-adt-api`, which supplied the one piece probing could not: SAP names
 * missing ATTRIBUTES but not missing ELEMENTS, and what was missing was the
 * `<syncScope>` child. Every "Data is invalid and could not be converted"
 * during that hunt was that one element.
 */

import type { IAbapConnection, ILogger } from '@mcp-abap-adt/interfaces';
import { XMLParser } from 'fast-xml-parser';
import { makeAdtRequestWithTimeout } from '../utils';
import { getDebuggerIdentity, getDebuggerUser } from './debuggerIdentity';

const BREAKPOINTS_URL = '/sap/bc/adt/debugger/breakpoints';

export interface AbapBreakpoint {
  /** SAP's own handle, e.g. KIND=0.SOURCETYPE=ABAP.MAIN_PROGRAM=Z.LINE_NR=7 */
  id?: string;
  kind: string;
  clientId: string;
  uri: string;
  condition?: string;
  /** Object the breakpoint sits in, as SAP reports it. */
  objectName?: string;
  objectType?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  isArray: (name) => name === 'breakpoint',
});

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Parse a `<dbg:breakpoints>` document into plain objects. */
export function parseBreakpoints(xml: string): AbapBreakpoint[] {
  if (!xml || !xml.trim()) return [];

  const parsed = parser.parse(xml);
  const root = parsed?.['dbg:breakpoints'] ?? parsed?.breakpoints;
  const entries = root?.breakpoint;
  if (!Array.isArray(entries)) return [];

  return entries.map((entry: any) => ({
    id: entry['@_id'],
    kind: entry['@_kind'] ?? 'line',
    clientId: entry['@_clientId'] ?? '',
    uri: entry['@_adtcore:uri'] ?? entry['@_uri'] ?? '',
    condition: entry['@_condition'] || undefined,
    // SAP pads this field, and the padding is not part of the name.
    objectName: String(entry['@_adtcore:name'] ?? '')
      .trim()
      .split(/\s+/)[0],
    objectType: entry['@_adtcore:type'],
  }));
}

/**
 * What THIS server has registered, keyed by source URI.
 *
 * SAP offers no way to read the set back: `GET /sap/bc/adt/debugger/breakpoints`
 * answers empty however it is called — with and without identity parameters,
 * and immediately after a successful POST. Its relation is *synchronize*, and
 * it returns conflicts, not a listing.
 *
 * That matters because `syncScope mode="full"` makes every POST the complete
 * new set: anything omitted is deleted. Without a record of what is already
 * there, setting a second breakpoint silently removes the first — which is
 * exactly what happened before this registry existed.
 *
 * The registry is refreshed from each POST response, which IS authoritative:
 * SAP echoes back the set it now holds.
 *
 * Two limits, both real. It is process-local, so breakpoints registered by an
 * earlier run of this server are invisible to it — `deleteAllBreakpoints()`
 * clears those regardless, since an empty sync wipes the set whatever the
 * registry believes. And it cannot see breakpoints set by another IDE, though
 * those live under a different ideId and are not affected by our syncs.
 */
const registry = new Map<string, AbapBreakpoint>();

/** Refresh the registry from a POST response, which reflects reality. */
function adoptServerState(breakpoints: AbapBreakpoint[]): AbapBreakpoint[] {
  registry.clear();
  for (const breakpoint of breakpoints) {
    if (breakpoint.uri) registry.set(breakpoint.uri, breakpoint);
  }
  return breakpoints;
}

/**
 * The breakpoints this server has registered.
 *
 * Deliberately NOT a call to SAP: that endpoint cannot answer the question.
 */
export function listBreakpoints(): AbapBreakpoint[] {
  return [...registry.values()];
}

function renderBreakpoint(breakpoint: AbapBreakpoint): string {
  const condition = breakpoint.condition
    ? ` condition="${escapeXmlAttribute(breakpoint.condition)}"`
    : '';
  return `<breakpoint xmlns:adtcore="http://www.sap.com/adt/core" kind="${escapeXmlAttribute(
    breakpoint.kind,
  )}" clientId="${escapeXmlAttribute(
    breakpoint.clientId,
  )}" skipCount="0" adtcore:uri="${escapeXmlAttribute(breakpoint.uri)}"${condition}/>`;
}

/**
 * Replace the registered breakpoint set with exactly this list.
 *
 * `syncScope mode="full"` means the request IS the new set: anything omitted is
 * deleted. Callers that mean to add should read the current list first — see
 * `addBreakpoint`.
 */
export async function syncBreakpoints(
  connection: IAbapConnection,
  breakpoints: AbapBreakpoint[],
  logger?: ILogger,
): Promise<AbapBreakpoint[]> {
  const identity = getDebuggerIdentity();
  const requestUser = getDebuggerUser();

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<dbg:breakpoints scope="external" debuggingMode="user" requestUser="${escapeXmlAttribute(
    requestUser ?? '',
  )}" terminalId="${identity.terminalId}" ideId="${identity.ideId}" systemDebugging="false" deactivated="false" xmlns:dbg="http://www.sap.com/adt/debugger">
  <syncScope mode="full"></syncScope>
  ${breakpoints.map(renderBreakpoint).join('\n  ')}
</dbg:breakpoints>`;

  logger?.debug(`Synchronising ${breakpoints.length} breakpoint(s)`);

  const response = await makeAdtRequestWithTimeout(
    connection,
    BREAKPOINTS_URL,
    'POST',
    'default',
    body,
    undefined,
    { 'Content-Type': 'application/xml', Accept: 'application/xml' },
  );

  return parseBreakpoints(
    typeof response.data === 'string' ? response.data : '',
  );
}

/**
 * Add a breakpoint, keeping the ones already registered.
 *
 * A plain sync would silently drop every other breakpoint the user had set,
 * which is the kind of quiet loss that is only noticed when a debugging session
 * fails to stop where it should.
 */
export async function addBreakpoint(
  connection: IAbapConnection,
  breakpoint: AbapBreakpoint,
  logger?: ILogger,
): Promise<{ all: AbapBreakpoint[]; added: AbapBreakpoint | undefined }> {
  // Re-setting the same position replaces it rather than duplicating it.
  const kept = [...registry.values()].filter(
    (entry) => entry.uri !== breakpoint.uri,
  );

  const all = adoptServerState(
    await syncBreakpoints(connection, [...kept, breakpoint], logger),
  );

  return { all, added: all.find((entry) => entry.uri === breakpoint.uri) };
}

/** Remove one breakpoint by the id SAP assigned it. */
export async function deleteBreakpoint(
  connection: IAbapConnection,
  breakpointId: string,
  logger?: ILogger,
): Promise<AbapBreakpoint[]> {
  const existing = [...registry.values()];
  const remaining = existing.filter((entry) => entry.id !== breakpointId);

  if (remaining.length === existing.length) {
    throw new Error(
      `No breakpoint with id "${breakpointId}" is registered by this server. Use DebuggerListBreakpoints to see the current set, or delete them all with all=true.`,
    );
  }

  logger?.info(`Removing breakpoint ${breakpointId}`);
  return adoptServerState(await syncBreakpoints(connection, remaining, logger));
}

/**
 * Clear every breakpoint under this IDE identity.
 *
 * An empty sync wipes the set on the server whatever the registry believes, so
 * this also recovers from breakpoints left behind by an earlier server run.
 */
export async function deleteAllBreakpoints(
  connection: IAbapConnection,
  logger?: ILogger,
): Promise<void> {
  await syncBreakpoints(connection, [], logger);
  registry.clear();
}

/**
 * Build the source URI a line breakpoint points at.
 *
 * The line number rides in the fragment (`#start=N`), which is why a plain
 * object URI is not enough.
 */
export function lineBreakpointUri(objectUri: string, line: number): string {
  return `${objectUri}#start=${Math.max(1, Math.trunc(line))}`;
}
