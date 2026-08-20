/**
 * Stable identity for ABAP debugger sessions.
 *
 * The ADT debugger correlates a listener with the later stack, variable, step
 * and stop calls by `ideId` + `terminalId`. Two consequences follow, and the
 * second one bites hardest:
 *
 * 1. The pair must not change between calls of one session, or SAP treats each
 *    request as coming from a different IDE and finds no session.
 * 2. The pair must be reproducible across PROCESSES. A random per-process
 *    identity means a `DebuggerStop` cannot release a listener registered by an
 *    earlier run — the listener is orphaned server-side and holds the user's
 *    session captive at the next breakpoint. (Observed: a listener registered
 *    as MCP_ABAP_ADT_1691DC7D survived a stop that identified itself as
 *    MCP_ABAP_ADT_FDC1D45E, and had to be deleted by hand.)
 *
 * So the identity is DERIVED, not generated: a hash over the SAP user, system
 * URL and client. Same user on the same system always yields the same pair, so
 * a stop always matches its listener. Including the URL and client keeps two
 * systems from sharing one identity, and the fixed namespace keeps it clear of
 * a real Eclipse session for the same user.
 */

import { createHash } from 'node:crypto';

const NAMESPACE = 'mcp-abap-adt-fira/debugger';

function derive(): { ideId: string; terminalId: string } {
  const user = (
    process.env.SAP_RESPONSIBLE ||
    process.env.SAP_USERNAME ||
    'unknown'
  ).toUpperCase();
  const system = process.env.SAP_URL || 'unknown';
  const client = process.env.SAP_CLIENT || '';

  const digest = createHash('sha256')
    .update(`${NAMESPACE}|${system}|${client}|${user}`)
    .digest('hex')
    .toUpperCase();

  // terminalId is conventionally a UUID; shaping the digest that way keeps SAP
  // and any log reader from tripping over an unexpected format.
  const terminalId = [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join('-');

  return { ideId: `MCP_ABAP_ADT_${digest.slice(0, 8)}`, terminalId };
}

let identity: { ideId: string; terminalId: string } | undefined;

export function getDebuggerIdentity(): { ideId: string; terminalId: string } {
  if (!identity) identity = derive();
  return identity;
}

/** The user whose sessions the debugger listens for. */
export function getDebuggerUser(requestUser?: string): string | undefined {
  const user =
    requestUser || process.env.SAP_RESPONSIBLE || process.env.SAP_USERNAME;
  return user ? user.toUpperCase() : undefined;
}
