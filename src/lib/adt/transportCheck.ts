/**
 * Pre-release inspection of a transport request.
 *
 * The fork can already create and release transports. What was missing is the
 * question asked immediately before releasing one: am I about to break the
 * downstream system?
 *
 * The analysis runs against the transport tables (`E070`, `E071`, `E07T`)
 * rather than an ADT endpoint, because those give the whole picture in a few
 * queries: the request header, its tasks, its objects, and — the one that
 * matters most — whether any of those objects also sit in somebody else's open
 * request, which is how half a change reaches the next system.
 *
 * `analyseTransport` is deliberately pure. Everything that talks to SAP is
 * confined to `gatherTransportData`, so the judgement can be tested exhaustively
 * without a system.
 */

import type { IAbapConnection, ILogger } from '@mcp-abap-adt/interfaces';

/** E070-TRSTATUS. Anything not modifiable can no longer be changed. */
export const MODIFIABLE_STATUSES = new Set(['D', 'L']);
const RELEASED_STATUSES = new Set(['R', 'N']);
const RELEASE_STARTED = 'O';

/** E070-TRFUNCTION. K and W are requests; the rest are tasks within one. */
const WORKBENCH_REQUEST = 'K';
const CUSTOMIZING_REQUEST = 'W';
const TRANSPORT_OF_COPIES = 'T';
const REQUEST_FUNCTIONS = new Set([
  WORKBENCH_REQUEST,
  CUSTOMIZING_REQUEST,
  TRANSPORT_OF_COPIES,
]);

export interface TransportHeader {
  trkorr: string;
  /** E070-TRFUNCTION */
  function: string;
  /** E070-TRSTATUS */
  status: string;
  /** E070-TARSYSTEM — blank means the request goes nowhere. */
  target: string;
  owner: string;
  description?: string;
  /** E070-STRKORR — set on a task, naming its request. */
  parent?: string;
}

export interface TransportObject {
  pgmid: string;
  type: string;
  name: string;
  /** Which request or task inside this transport holds the object. */
  trkorr: string;
}

/** The same object sitting in a different, still-open request. */
export interface ObjectElsewhere {
  pgmid: string;
  type: string;
  name: string;
  otherTrkorr: string;
  otherOwner: string;
  otherStatus: string;
  otherDescription?: string;
}

export interface TransportData {
  header?: TransportHeader;
  tasks: TransportHeader[];
  objects: TransportObject[];
  elsewhere: ObjectElsewhere[];
}

export type Severity = 'blocker' | 'warning' | 'info';

export interface TransportFinding {
  severity: Severity;
  code: string;
  message: string;
  detail?: unknown;
}

export interface TransportAnalysis {
  transport: string;
  found: boolean;
  releasable: boolean;
  header?: TransportHeader;
  objectCount: number;
  taskCount: number;
  openTaskCount: number;
  findings: TransportFinding[];
}

const isRequest = (header: TransportHeader) =>
  REQUEST_FUNCTIONS.has(header.function);

function describeStatus(status: string): string {
  if (MODIFIABLE_STATUSES.has(status)) return 'modifiable';
  if (status === RELEASE_STARTED) return 'release started';
  if (RELEASED_STATUSES.has(status)) return 'released';
  return `status ${status}`;
}

/**
 * Judge a transport from the rows describing it.
 *
 * Pure by design: no connection, no clock, no I/O. Every rule below is a
 * statement about the data, so the whole judgement is testable offline.
 */
export function analyseTransport(
  transport: string,
  data: TransportData,
): TransportAnalysis {
  const findings: TransportFinding[] = [];
  const { header } = data;

  if (!header) {
    return {
      transport,
      found: false,
      releasable: false,
      objectCount: 0,
      taskCount: 0,
      openTaskCount: 0,
      findings: [
        {
          severity: 'blocker',
          code: 'not_found',
          message: `Transport ${transport} does not exist in this system.`,
        },
      ],
    };
  }

  const openTasks = data.tasks.filter((task) =>
    MODIFIABLE_STATUSES.has(task.status),
  );

  if (RELEASED_STATUSES.has(header.status)) {
    findings.push({
      severity: 'info',
      code: 'already_released',
      message: `Transport ${transport} is already released — there is nothing left to check before release.`,
    });
  } else if (header.status === RELEASE_STARTED) {
    findings.push({
      severity: 'warning',
      code: 'release_in_progress',
      message: `Release of ${transport} has already started. Wait for it to finish rather than starting another.`,
    });
  }

  if (data.objects.length === 0) {
    findings.push({
      severity: 'blocker',
      code: 'empty',
      message: `Transport ${transport} contains no objects. Releasing it moves nothing and still consumes a transport number.`,
    });
  }

  // A workbench request with no target is the LOCAL trap: it releases without
  // complaint and never arrives anywhere.
  if (
    isRequest(header) &&
    header.function !== TRANSPORT_OF_COPIES &&
    !header.target.trim()
  ) {
    findings.push({
      severity: 'blocker',
      code: 'no_target',
      message: `Transport ${transport} has no target system, so it is local. It will release successfully and never reach another system.`,
    });
  }

  // SAP refuses to release a request whose tasks are still open, and the error
  // it gives is not obvious.
  if (openTasks.length > 0) {
    findings.push({
      severity: 'blocker',
      code: 'open_tasks',
      message: `${openTasks.length} task${openTasks.length === 1 ? '' : 's'} under ${transport} ${openTasks.length === 1 ? 'is' : 'are'} still open. SAP will not release the request until every task is released.`,
      detail: openTasks.map((task) => ({
        task: task.trkorr,
        owner: task.owner,
        status: describeStatus(task.status),
      })),
    });
  }

  // The one that actually causes broken downstream systems: an object changed
  // in two open requests. Releasing one takes a partial version.
  if (data.elsewhere.length > 0) {
    const others = [...new Set(data.elsewhere.map((o) => o.otherTrkorr))];
    findings.push({
      severity: 'warning',
      code: 'objects_in_other_requests',
      message: `${data.elsewhere.length} object${data.elsewhere.length === 1 ? '' : 's'} in this transport also sit in ${others.length} other open request${others.length === 1 ? '' : 's'}. Releasing this one alone moves a partial version of ${data.elsewhere.length === 1 ? 'that object' : 'those objects'}.`,
      detail: data.elsewhere.map((o) => ({
        object: `${o.pgmid} ${o.type} ${o.name}`,
        also_in: o.otherTrkorr,
        owner: o.otherOwner,
        status: describeStatus(o.otherStatus),
        description: o.otherDescription,
      })),
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: 'info',
      code: 'clean',
      message: `No pre-release problems found in ${transport}: ${data.objects.length} object${data.objects.length === 1 ? '' : 's'}, target ${header.target || '(none)'}.`,
    });
  }

  return {
    transport,
    found: true,
    releasable: !findings.some((f) => f.severity === 'blocker'),
    header,
    objectCount: data.objects.length,
    taskCount: data.tasks.length,
    openTaskCount: openTasks.length,
    findings,
  };
}

/** Rows as the SQL layer returns them: every column a string. */
type Row = Record<string, string>;

const text = (row: Row, key: string) => String(row?.[key] ?? '').trim();

export function rowToHeader(row: Row): TransportHeader {
  return {
    trkorr: text(row, 'TRKORR'),
    function: text(row, 'TRFUNCTION'),
    status: text(row, 'TRSTATUS'),
    target: text(row, 'TARSYSTEM'),
    owner: text(row, 'AS4USER'),
    parent: text(row, 'STRKORR') || undefined,
  };
}

/** Runs a query through the same path the SQL tool uses. */
export type RowReader = (sql: string, maxRows: number) => Promise<Row[]>;

/**
 * Collect everything the analysis needs.
 *
 * Kept separate from the judgement so the rules can be tested without SAP, and
 * so a change to how rows are fetched cannot quietly alter what counts as a
 * problem.
 */
export async function gatherTransportData(
  readRows: RowReader,
  transport: string,
  options?: { maxObjects?: number },
): Promise<TransportData> {
  const trkorr = transport.toUpperCase().trim();
  const maxObjects = options?.maxObjects ?? 2000;

  const headers = await readRows(
    `SELECT TRKORR, TRFUNCTION, TRSTATUS, TARSYSTEM, AS4USER, STRKORR FROM E070 WHERE TRKORR = '${trkorr}'`,
    2,
  );
  const header = headers.length ? rowToHeader(headers[0]) : undefined;
  if (!header) return { tasks: [], objects: [], elsewhere: [] };

  const [taskRows, objectRows] = await Promise.all([
    readRows(
      `SELECT TRKORR, TRFUNCTION, TRSTATUS, TARSYSTEM, AS4USER, STRKORR FROM E070 WHERE STRKORR = '${trkorr}'`,
      200,
    ),
    // Objects live on the tasks, not on the request, so both are queried.
    readRows(
      `SELECT e~TRKORR, e~PGMID, e~OBJECT, e~OBJ_NAME FROM E071 AS e INNER JOIN E070 AS h ON h~TRKORR = e~TRKORR WHERE h~TRKORR = '${trkorr}' OR h~STRKORR = '${trkorr}'`,
      maxObjects,
    ),
  ]);

  const tasks = taskRows.map(rowToHeader);
  const objects: TransportObject[] = objectRows.map((row) => ({
    trkorr: text(row, 'TRKORR'),
    pgmid: text(row, 'PGMID'),
    type: text(row, 'OBJECT'),
    name: text(row, 'OBJ_NAME'),
  }));

  const elsewhere = objects.length
    ? await findObjectsElsewhere(readRows, trkorr, objects)
    : [];

  return { header, tasks, objects, elsewhere };
}

/**
 * Find the transport's objects in other requests that are still open.
 *
 * Queried by object name in batches rather than one statement per object: a
 * transport with hundreds of objects would otherwise mean hundreds of round
 * trips. Requests belonging to this transport's own task tree are excluded, or
 * every object would report itself.
 */
async function findObjectsElsewhere(
  readRows: RowReader,
  trkorr: string,
  objects: TransportObject[],
  batchSize = 40,
): Promise<ObjectElsewhere[]> {
  const names = [...new Set(objects.map((o) => o.name))].filter(Boolean);
  const statuses = [...MODIFIABLE_STATUSES]
    .map((status) => `'${status}'`)
    .join(', ');

  const found: ObjectElsewhere[] = [];
  const ownTree = new Set([trkorr, ...objects.map((o) => o.trkorr)]);

  for (let start = 0; start < names.length; start += batchSize) {
    const batch = names
      .slice(start, start + batchSize)
      // A quote in an object name would break the statement; SAP names cannot
      // contain one, so anything that does is not a real object.
      .filter((name) => !name.includes("'"))
      .map((name) => `'${name}'`);
    if (!batch.length) continue;

    const rows = await readRows(
      `SELECT e~TRKORR, e~PGMID, e~OBJECT, e~OBJ_NAME, h~AS4USER, h~TRSTATUS, h~STRKORR ` +
        `FROM E071 AS e INNER JOIN E070 AS h ON h~TRKORR = e~TRKORR ` +
        `WHERE e~OBJ_NAME IN ( ${batch.join(', ')} ) AND h~TRSTATUS IN ( ${statuses} )`,
      2000,
    );

    for (const row of rows) {
      const otherTrkorr = text(row, 'TRKORR');
      const parent = text(row, 'STRKORR');
      if (ownTree.has(otherTrkorr) || ownTree.has(parent)) continue;

      const name = text(row, 'OBJ_NAME');
      const type = text(row, 'OBJECT');
      // The name query is deliberately loose; keep only genuine matches.
      if (!objects.some((o) => o.name === name && o.type === type)) continue;

      found.push({
        pgmid: text(row, 'PGMID'),
        type,
        name,
        otherTrkorr,
        otherOwner: text(row, 'AS4USER'),
        otherStatus: text(row, 'TRSTATUS'),
      });
    }
  }

  return found;
}

/** Build a RowReader over an ADT connection using the SQL data preview. */
export function makeRowReader(
  connection: IAbapConnection,
  logger: ILogger | undefined,
  runQuery: (sql: string, maxRows: number) => Promise<Row[]>,
): RowReader {
  return async (sql, maxRows) => {
    logger?.debug?.(`[transport-check] ${sql}`);
    return runQuery(sql, maxRows);
  };
}
