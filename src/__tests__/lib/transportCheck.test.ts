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
  gatherTransportData,
  rowToHeader,
  type TransportData,
  type TransportHeader,
} from '../../lib/adt/transportCheck';

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

  it("excludes the transport's own task tree from the cross-request search", async () => {
    const reader = jest.fn(async (sql: string) => {
      if (sql.includes('FROM E070 WHERE TRKORR')) {
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
      // The objects query also contains `STRKORR =`, so the task branch has to
      // match the full clause or it swallows both.
      if (sql.includes('FROM E070 WHERE STRKORR =')) return [];
      if (sql.includes('OBJ_NAME IN')) {
        return [
          // The object's own task — must not be reported.
          {
            TRKORR: 'DEVK900002',
            PGMID: 'R3TR',
            OBJECT: 'PROG',
            OBJ_NAME: 'ZDEMO',
            AS4USER: 'DEVUSER',
            TRSTATUS: 'D',
            STRKORR: 'DEVK900001',
          },
          // Somebody else's request — must be reported.
          {
            TRKORR: 'DEVK900099',
            PGMID: 'R3TR',
            OBJECT: 'PROG',
            OBJ_NAME: 'ZDEMO',
            AS4USER: 'OTHER',
            TRSTATUS: 'D',
            STRKORR: '',
          },
          // Same name, different object type — a false match to discard.
          {
            TRKORR: 'DEVK900098',
            PGMID: 'R3TR',
            OBJECT: 'TABL',
            OBJ_NAME: 'ZDEMO',
            AS4USER: 'OTHER',
            TRSTATUS: 'D',
            STRKORR: '',
          },
        ];
      }
      return [
        {
          TRKORR: 'DEVK900002',
          PGMID: 'R3TR',
          OBJECT: 'PROG',
          OBJ_NAME: 'ZDEMO',
        },
      ];
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
});
