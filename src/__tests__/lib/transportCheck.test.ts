/**
 * The judgement is pure, so it can be tested exhaustively without a system —
 * including the cases that are awkward to stage on a real one, like a request
 * whose tasks are still open or an object sitting in someone else's transport.
 *
 * What these tests cannot confirm is that the queries return these rows. That
 * needs a live system.
 */

import {
  analyseTransport,
  batchByLength,
  gatherTransportData,
  rowToHeader,
  type TransportData,
  type TransportHeader,
} from '../../lib/adt/transportCheck';
import { SQL_MAX_LENGTH } from '../../lib/utils';

const header = (over: Partial<TransportHeader> = {}): TransportHeader => ({
  trkorr: 'DEVK900001',
  function: 'K',
  status: 'D',
  target: 'QAS',
  owner: 'DEVUSER',
  ...over,
});

const data = (over: Partial<TransportData> = {}): TransportData => ({
  header: header(),
  tasks: [],
  objects: [
    { pgmid: 'R3TR', type: 'PROG', name: 'ZDEMO', trkorr: 'DEVK900001' },
  ],
  elsewhere: [],
  ...over,
});

const codes = (result: { findings: Array<{ code: string }> }) =>
  result.findings.map((f) => f.code);

describe('analyseTransport', () => {
  it('passes a request with a target and no complications', () => {
    const result = analyseTransport('DEVK900001', data());
    expect(result.releasable).toBe(true);
    expect(codes(result)).toEqual(['clean']);
  });

  it('reports a transport that does not exist as a blocker', () => {
    const result = analyseTransport('DEVK999999', {
      tasks: [],
      objects: [],
      elsewhere: [],
    });
    expect(result.found).toBe(false);
    expect(result.releasable).toBe(false);
    expect(codes(result)).toEqual(['not_found']);
  });

  it('blocks an empty transport', () => {
    const result = analyseTransport('DEVK900001', data({ objects: [] }));
    expect(result.releasable).toBe(false);
    expect(codes(result)).toContain('empty');
  });

  it('blocks a workbench request with no target', () => {
    // Releases without complaint and never arrives anywhere.
    const result = analyseTransport(
      'DEVK900001',
      data({ header: header({ target: '   ' }) }),
    );
    expect(result.releasable).toBe(false);
    expect(codes(result)).toContain('no_target');
  });

  it('does not demand a target from a transport of copies', () => {
    const result = analyseTransport(
      'DEVK900001',
      data({ header: header({ function: 'T', target: '' }) }),
    );
    expect(codes(result)).not.toContain('no_target');
  });

  it('blocks a request whose tasks are still open, and names them', () => {
    const result = analyseTransport(
      'DEVK900001',
      data({
        tasks: [
          header({
            trkorr: 'DEVK900002',
            function: 'S',
            status: 'D',
            owner: 'OTHER',
          }),
          header({ trkorr: 'DEVK900003', function: 'S', status: 'R' }),
        ],
      }),
    );
    expect(result.releasable).toBe(false);
    expect(result.openTaskCount).toBe(1);
    const finding = result.findings.find((f) => f.code === 'open_tasks');
    expect(finding?.detail).toEqual([
      { task: 'DEVK900002', owner: 'OTHER', status: 'modifiable' },
    ]);
  });

  it('warns, without blocking, when an object sits in another open request', () => {
    const result = analyseTransport(
      'DEVK900001',
      data({
        elsewhere: [
          {
            pgmid: 'R3TR',
            type: 'PROG',
            name: 'ZDEMO',
            otherTrkorr: 'DEVK900010',
            otherOwner: 'OTHER',
            otherStatus: 'D',
          },
        ],
      }),
    );
    // A genuine judgement call rather than a rule: this is often intentional,
    // so it must be visible without stopping the release.
    expect(result.releasable).toBe(true);
    const finding = result.findings.find(
      (f) => f.code === 'objects_in_other_requests',
    );
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('partial version');
  });

  it('counts distinct objects, not the rows they appear in', () => {
    // One object in three other requests is three rows. Reporting "3 objects"
    // overstates it, visibly so when the transport holds fewer than that.
    const result = analyseTransport(
      'DEVK900001',
      data({
        elsewhere: ['DEVK900010', 'DEVK900011', 'DEVK900012'].map((other) => ({
          pgmid: 'R3TR',
          type: 'PROG',
          name: 'ZDEMO',
          otherTrkorr: other,
          otherOwner: 'OTHER',
          otherStatus: 'D',
        })),
      }),
    );
    const finding = result.findings.find(
      (f) => f.code === 'objects_in_other_requests',
    );
    expect(finding?.message).toContain('1 of the 1 object');
    expect(finding?.message).toContain('3 other open requests');
    expect(finding?.message).toContain('3 placements');
  });

  it('reports an already released transport as info, not as a problem', () => {
    const result = analyseTransport(
      'DEVK900001',
      data({ header: header({ status: 'R' }) }),
    );
    expect(codes(result)).toContain('already_released');
    expect(result.releasable).toBe(true);
  });

  it('accumulates every blocker rather than stopping at the first', () => {
    const result = analyseTransport(
      'DEVK900001',
      data({
        header: header({ target: '' }),
        objects: [],
        tasks: [header({ trkorr: 'DEVK900002', status: 'D' })],
      }),
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining(['empty', 'no_target', 'open_tasks']),
    );
    expect(result.releasable).toBe(false);
  });
});

describe('rowToHeader', () => {
  it('trims what SAP pads and drops an empty parent', () => {
    expect(
      rowToHeader({
        TRKORR: 'DEVK900001 ',
        TRFUNCTION: 'K',
        TRSTATUS: 'D',
        TARSYSTEM: 'QAS  ',
        AS4USER: 'DEVUSER',
        STRKORR: '',
      }),
    ).toEqual({
      trkorr: 'DEVK900001',
      function: 'K',
      status: 'D',
      target: 'QAS',
      owner: 'DEVUSER',
      parent: undefined,
    });
  });
});

describe('gatherTransportData', () => {
  it('stops after the header when the transport does not exist', async () => {
    const reader = jest.fn(async () => []);
    const result = await gatherTransportData(reader, 'DEVK999999');
    expect(reader).toHaveBeenCalledTimes(1);
    expect(result.header).toBeUndefined();
  });

  it('excludes its own task tree, wrong types, and SAP piece lists', async () => {
    const reader = jest.fn(async (sql: string) => {
      if (sql.includes('FROM E070 WHERE TRKORR =')) {
        return [
          {
            TRKORR: 'DEVK900001',
            TRFUNCTION: 'K',
            TRSTATUS: 'D',
            TARSYSTEM: 'QAS',
            AS4USER: 'DEVUSER',
            STRKORR: '',
          },
        ];
      }
      if (sql.includes('FROM E070 WHERE STRKORR =')) return [];

      // Objects held by this transport, on its task.
      if (sql.includes('INNER JOIN')) {
        return [
          {
            TRKORR: 'DEVK900002',
            PGMID: 'R3TR',
            OBJECT: 'PROG',
            OBJ_NAME: 'ZDEMO',
          },
        ];
      }

      // Everywhere that object name appears.
      if (sql.includes('OBJ_NAME IN')) {
        return [
          { TRKORR: 'DEVK900002', OBJECT: 'PROG', OBJ_NAME: 'ZDEMO' }, // own task
          { TRKORR: 'DEVK900099', OBJECT: 'PROG', OBJ_NAME: 'ZDEMO' }, // someone else
          { TRKORR: 'DEVK900098', OBJECT: 'TABL', OBJ_NAME: 'ZDEMO' }, // other type
          { TRKORR: 'PIECELIST1', OBJECT: 'PROG', OBJ_NAME: 'ZDEMO' }, // SAP list
          { TRKORR: 'DEVK900097', OBJECT: 'PROG', OBJ_NAME: 'ZDEMO' }, // released
        ];
      }

      // Headers for those candidates.
      if (sql.includes('FROM E070 WHERE TRKORR IN')) {
        return [
          {
            TRKORR: 'DEVK900099',
            TRFUNCTION: 'K',
            TRSTATUS: 'D',
            AS4USER: 'OTHER',
            STRKORR: '',
          },
          {
            TRKORR: 'DEVK900098',
            TRFUNCTION: 'K',
            TRSTATUS: 'D',
            AS4USER: 'OTHER',
            STRKORR: '',
          },
          {
            // TRFUNCTION F is a piece list, not a request anyone releases.
            TRKORR: 'PIECELIST1',
            TRFUNCTION: 'F',
            TRSTATUS: 'D',
            AS4USER: 'SAP',
            STRKORR: '',
          },
          {
            TRKORR: 'DEVK900097',
            TRFUNCTION: 'K',
            TRSTATUS: 'R',
            AS4USER: 'OTHER',
            STRKORR: '',
          },
        ];
      }
      return [];
    });

    const result = await gatherTransportData(reader, 'DEVK900001');
    expect(result.elsewhere).toEqual([
      {
        pgmid: 'R3TR',
        type: 'PROG',
        name: 'ZDEMO',
        otherTrkorr: 'DEVK900099',
        otherOwner: 'OTHER',
        otherStatus: 'D',
      },
    ]);
  });

  it('keeps every generated statement within the length SAP accepts', async () => {
    // 255 characters, measured against a live system. Over it, SAP answers
    // "Only one SELECT statement is allowed", which reads like a syntax error.
    const names = Array.from(
      { length: 60 },
      (_, i) => `ZOBJECT_WITH_A_FAIRLY_LONG_NAME_${String(i).padStart(3, '0')}`,
    );
    const seen: string[] = [];
    const reader = jest.fn(async (sql: string) => {
      seen.push(sql);
      if (sql.includes('FROM E070 WHERE TRKORR =')) {
        return [
          {
            TRKORR: 'DEVK900001',
            TRFUNCTION: 'K',
            TRSTATUS: 'D',
            TARSYSTEM: 'QAS',
            AS4USER: 'DEVUSER',
            STRKORR: '',
          },
        ];
      }
      if (sql.includes('FROM E070 WHERE STRKORR =')) return [];
      if (sql.includes('INNER JOIN')) {
        return names.map((name) => ({
          TRKORR: 'DEVK900001',
          PGMID: 'R3TR',
          OBJECT: 'PROG',
          OBJ_NAME: name,
        }));
      }
      return [];
    });

    await gatherTransportData(reader, 'DEVK900001');
    expect(seen.length).toBeGreaterThan(3);
    for (const sql of seen) {
      expect(sql.length).toBeLessThanOrEqual(SQL_MAX_LENGTH);
    }
  });
});

describe('batchByLength', () => {
  it('splits so each statement stays within the limit', () => {
    const values = Array.from({ length: 20 }, (_, i) => `NAME_${i}`);
    const batches = batchByLength(values, 60, 120);
    for (const batch of batches) {
      const length = 60 + batch.reduce((sum, v) => sum + v.length + 4, 0);
      expect(length).toBeLessThanOrEqual(120);
    }
    expect(batches.flat()).toEqual(values);
  });

  it('never drops a value that cannot fit on its own', () => {
    // Better a statement SAP rejects than one silently missing an object.
    const huge = 'X'.repeat(300);
    expect(batchByLength([huge], 60, 120)).toEqual([[huge]]);
  });

  it('returns nothing for no values', () => {
    expect(batchByLength([], 60, 120)).toEqual([]);
  });
});
