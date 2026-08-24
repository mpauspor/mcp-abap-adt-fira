/**
 * ABAP Test Cockpit over ADT.
 *
 * The ADT client library exposes nothing for ATC, so this drives the REST API
 * directly. The three-step flow was established against a live 7.5x system:
 *
 *   POST /sap/bc/adt/atc/worklists?checkVariant=<v>   -> worklist id (plain text)
 *   POST /sap/bc/adt/atc/runs?worklistId=<id>         -> run, body is the object set
 *   GET  /sap/bc/adt/atc/worklists/<id>               -> the findings
 *
 * Two things worth knowing, both found by probing rather than from docs:
 *
 * - A package works as an object set, so scanning a whole package is one call
 *   rather than a fan-out over its contents.
 * - The worklist reports `objectSetIsComplete`. ATC silently caps what it
 *   analyses, and without that flag a truncated run reads exactly like a clean
 *   one. It is surfaced rather than dropped.
 */

import type { IAbapConnection } from '@mcp-abap-adt/interfaces';
import { encodeSapObjectName, makeAdtRequestWithTimeout } from '../utils';
import { buildObjectUri } from './objectUri';

const ATC_BASE = '/sap/bc/adt/atc';

/** ATC priorities. 1 is the most severe; 3 is advisory. */
export type AtcPriority = 1 | 2 | 3 | 4;

export interface AtcFinding {
  objectName: string;
  objectType: string;
  packageName: string;
  author: string;
  priority: number;
  checkTitle: string;
  messageId: string;
  message: string;
  /** Include the finding actually sits in — often not the object that was scanned. */
  include?: string;
  line?: number;
  /** Whether ATC offers a correction, and of what kind. */
  quickfix: {
    manual: boolean;
    automatic: boolean;
    /** A pseudo-comment suppresses the finding rather than fixing it. */
    pseudoComment: boolean;
  };
  exempted: boolean;
}

export interface AtcRunResult {
  worklistId: string;
  checkVariant: string;
  objectSet: string;
  /**
   * False when ATC did not analyse everything it was given. A truncated run
   * looks identical to a clean one without this.
   */
  objectSetComplete: boolean;
  objectsAnalysed: number;
  findings: AtcFinding[];
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The ADT URI for whatever ATC should scan.
 *
 * Packages take a path of their own; everything else goes through the fork's
 * URI map, which refuses a type it does not know instead of inventing a path.
 */
export function buildAtcObjectUri(target: {
  packageName?: string;
  objectName?: string;
  objectType?: string;
  uri?: string;
}): { uri: string; label: string } {
  if (target.uri) return { uri: target.uri, label: target.uri };

  if (target.packageName) {
    const name = target.packageName.toUpperCase();
    return {
      // $TMP and other namespaced packages must be encoded — a bare `$` is
      // dropped by the URI mapper.
      uri: `/sap/bc/adt/packages/${encodeSapObjectName(name.toLowerCase())}`,
      label: `package ${name}`,
    };
  }

  if (!target.objectName) {
    throw new Error(
      'Nothing to check: pass object_name, package_name or an explicit uri.',
    );
  }

  const name = target.objectName.toUpperCase();
  const uri = buildObjectUri({ name, type: target.objectType ?? 'PROG/P' });
  return { uri, label: `${target.objectType ?? 'PROG/P'} ${name}` };
}

async function adt(
  connection: IAbapConnection,
  url: string,
  method: 'GET' | 'POST',
  timeoutMs: number,
  body?: string,
): Promise<{ status: number; data: string }> {
  const response = await makeAdtRequestWithTimeout(
    connection,
    url,
    method,
    timeoutMs,
    body,
    {
      headers: body
        ? { Accept: '*/*', 'Content-Type': 'application/xml' }
        : { Accept: '*/*' },
    },
  );
  const data =
    typeof response.data === 'string'
      ? response.data
      : JSON.stringify(response.data);
  return { status: response.status, data };
}

/** Pull `key="value"` out of an XML tag, namespace prefix or not. */
function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`(?:[a-zA-Z]+:)?${name}="([^"]*)"`));
  return match ? decodeEntities(match[1]) : '';
}

/** SAP escapes quotes in check messages, and they read badly left encoded. */
function decodeEntities(value: string): string {
  return (
    value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      // Ampersand last, so a doubly-encoded entity is not mangled.
      .replace(/&amp;/g, '&')
  );
}

/**
 * The include and line a finding points at.
 *
 * `location` looks like
 * `/sap/bc/adt/programs/includes/mzfooo01/source/main?context=...#start=809,0`
 * — the include is where the problem actually is, which is frequently not the
 * object that was scanned.
 */
function parseLocation(location: string): { include?: string; line?: number } {
  const lineMatch = location.match(/#start=(\d+)/);
  const line = lineMatch ? Number(lineMatch[1]) : undefined;

  // The name is the segment before `/source/main`. Matching on collection
  // names instead would pick the wrong one: `/programs/includes/mzfoo01`
  // contains both `programs` and `includes`, and the first match wins.
  const path = location.split('?')[0].split('#')[0];
  const sourceMatch = path.match(/\/([^/]+)\/source\/main$/);
  const include = sourceMatch ? sourceMatch[1].toUpperCase() : undefined;

  return { include, line };
}

/**
 * Parse a worklist.
 *
 * Written against captured responses rather than a schema. It walks the raw
 * text instead of building a DOM because the object a finding belongs to is
 * given by nesting, and a flat tag scan keeps that association explicit and
 * cheap on a worklist with thousands of findings.
 */
export function parseAtcWorklist(xml: string): {
  objectSetComplete: boolean;
  objectsAnalysed: number;
  findings: AtcFinding[];
} {
  const worklistTag = xml.match(/<[a-zA-Z]*:?worklist[^>]*>/)?.[0] ?? '';
  // Absent attribute is treated as complete: only an explicit "false" is
  // evidence of truncation.
  const objectSetComplete =
    attr(worklistTag, 'objectSetIsComplete').toLowerCase() !== 'false';

  const findings: AtcFinding[] = [];
  let objectsAnalysed = 0;

  let current = {
    name: '',
    type: '',
    packageName: '',
    author: '',
  };

  // The namespace prefix must be followed by a colon. Written as
  // `[a-zA-Z]*:?` the colon is optional and separate, which lets `atc` +
  // nothing + `object` match inside the prefix of `<atcobject:findings>` —
  // that tag was read as an object and blanked the object every finding was
  // then attributed to.
  const tagPattern =
    /<(?:[a-zA-Z][\w.-]*:)?(object|finding|quickfixes)\b[^>]*>/g;
  let match: RegExpExecArray | null;
  let pending: AtcFinding | undefined;

  const flush = () => {
    if (pending) {
      findings.push(pending);
      pending = undefined;
    }
  };

  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((match = tagPattern.exec(xml)) !== null) {
    const tag = match[0];
    const kind = match[1];

    if (kind === 'object') {
      flush();
      objectsAnalysed += 1;
      current = {
        name: attr(tag, 'name'),
        type: attr(tag, 'type'),
        packageName: attr(tag, 'packageName'),
        author: attr(tag, 'author'),
      };
      continue;
    }

    if (kind === 'finding') {
      flush();
      const { include, line } = parseLocation(attr(tag, 'location'));
      pending = {
        objectName: current.name,
        objectType: current.type,
        packageName: current.packageName,
        author: current.author,
        priority: Number(attr(tag, 'priority')) || 0,
        checkTitle: attr(tag, 'checkTitle'),
        messageId: attr(tag, 'messageId'),
        message: attr(tag, 'messageTitle'),
        include,
        line,
        quickfix: { manual: false, automatic: false, pseudoComment: false },
        exempted: attr(tag, 'exemptionApproval') !== '',
      };
      continue;
    }

    // quickfixes is a child of the finding it belongs to.
    if (pending) {
      pending.quickfix = {
        manual: attr(tag, 'manual') === 'true',
        automatic: attr(tag, 'automatic') === 'true',
        pseudoComment: attr(tag, 'pseudo') === 'true',
      };
    }
  }

  flush();
  return { objectSetComplete, objectsAnalysed, findings };
}

/**
 * Run ATC over one object or package and return the findings.
 *
 * `maxFindings` is passed to SAP as `maximumVerdicts`, so the cap is applied at
 * the source rather than after transferring a worklist that may hold thousands
 * of entries.
 */
export async function runAtcCheck(
  connection: IAbapConnection,
  options: {
    packageName?: string;
    objectName?: string;
    objectType?: string;
    uri?: string;
    checkVariant?: string;
    maxFindings?: number;
    timeoutSeconds?: number;
  },
): Promise<AtcRunResult> {
  const checkVariant = options.checkVariant ?? 'DEFAULT';
  const maxFindings = Math.max(1, Math.min(options.maxFindings ?? 100, 10000));
  const timeoutMs = Math.max(30, options.timeoutSeconds ?? 300) * 1000;

  const { uri, label } = buildAtcObjectUri(options);

  const created = await adt(
    connection,
    `${ATC_BASE}/worklists?checkVariant=${encodeURIComponent(checkVariant)}`,
    'POST',
    60000,
  );
  const worklistId = created.data.trim();
  if (!worklistId || worklistId.includes('<')) {
    throw new Error(
      `ATC did not return a worklist id for check variant ${checkVariant}. Response: ${created.data.slice(0, 200)}`,
    );
  }

  const runBody =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<atc:run xmlns:atc="http://www.sap.com/adt/atc" maximumVerdicts="${maxFindings}">` +
    '<objectSets xmlns:adtcore="http://www.sap.com/adt/core">' +
    '<objectSet kind="inclusive"><adtcore:objectReferences>' +
    `<adtcore:objectReference adtcore:uri="${xmlEscape(uri)}"/>` +
    '</adtcore:objectReferences></objectSet></objectSets></atc:run>';

  await adt(
    connection,
    `${ATC_BASE}/runs?worklistId=${encodeURIComponent(worklistId)}`,
    'POST',
    timeoutMs,
    runBody,
  );

  const worklist = await adt(
    connection,
    `${ATC_BASE}/worklists/${encodeURIComponent(worklistId)}`,
    'GET',
    timeoutMs,
  );

  const parsed = parseAtcWorklist(worklist.data);

  return {
    worklistId,
    checkVariant,
    objectSet: label,
    objectSetComplete: parsed.objectSetComplete,
    objectsAnalysed: parsed.objectsAnalysed,
    findings: parsed.findings,
  };
}

/**
 * Condense findings so a run over a package is readable.
 *
 * A single legacy program produced 35 findings on the system this was built
 * against; a package produces thousands. Returning them as a flat list would
 * be useless, so the caller gets the shape of the problem first and a bounded
 * sample second.
 */
export function summariseFindings(findings: AtcFinding[]) {
  const byPriority: Record<string, number> = {};
  const byCheck = new Map<
    string,
    { count: number; priority: number; atWorst: number }
  >();
  const byObject = new Map<string, number>();

  for (const finding of findings) {
    const priorityKey = String(finding.priority);
    byPriority[priorityKey] = (byPriority[priorityKey] ?? 0) + 1;

    const check = byCheck.get(finding.checkTitle) ?? {
      count: 0,
      priority: finding.priority,
      atWorst: 0,
    };
    check.count += 1;
    // A check reports findings at several priorities. Carrying only the worst
    // one alongside the total count reads as though every finding were that
    // severe, so both numbers are kept.
    if (finding.priority < check.priority) {
      check.priority = finding.priority;
      check.atWorst = 1;
    } else if (finding.priority === check.priority) {
      check.atWorst += 1;
    }
    byCheck.set(finding.checkTitle, check);

    byObject.set(
      finding.objectName,
      (byObject.get(finding.objectName) ?? 0) + 1,
    );
  }

  const worstFirst = (
    a: [string, { count: number; priority: number; atWorst: number }],
    b: [string, { count: number; priority: number; atWorst: number }],
  ) => a[1].priority - b[1].priority || b[1].count - a[1].count;

  return {
    total: findings.length,
    by_priority: byPriority,
    fixable_automatically: findings.filter((f) => f.quickfix.automatic).length,
    top_checks: [...byCheck.entries()]
      .sort(worstFirst)
      .slice(0, 10)
      .map(([title, info]) => ({
        check: title,
        count: info.count,
        worst_priority: info.priority,
        at_worst_priority: info.atWorst,
      })),
    worst_objects: [...byObject.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ object: name, findings: count })),
  };
}
