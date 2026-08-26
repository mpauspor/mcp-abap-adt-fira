/**
 * The diff is pure, so the cases that matter can be forced directly — above all
 * the ones that would otherwise produce a confident, wrong answer.
 */

import {
  compareTableRows,
  rowKey,
  summariseDifferences,
  type TableRow,
} from '../../lib/adt/tableCompare';

const row = (over: Partial<TableRow> = {}): TableRow => ({
  MANDT: '100',
  BUKRS: '1000',
  BUTXT: 'Company',
  PERIV: 'K4',
  ...over,
});

describe('compareTableRows', () => {
  it('matches rows by key and reports identical ones', () => {
    const result = compareTableRows([row()], [row()], {
      keyFields: ['MANDT', 'BUKRS'],
    });
    expect(result.keyFields).toEqual(['BUKRS']);
    expect(result.identical).toBe(1);
    expect(result.different).toHaveLength(0);
  });

  it('ignores the client, which is per-connection rather than per-row', () => {
    // Same row, different client: identical, not a difference.
    const result = compareTableRows(
      [row({ MANDT: '100' })],
      [row({ MANDT: '200' })],
      {
        keyFields: ['MANDT', 'BUKRS'],
      },
    );
    expect(result.identical).toBe(1);
    expect(result.ignoredFields).toContain('MANDT');
  });

  it('refuses to compare when no key is left to match by', () => {
    // Without this the empty key pairs unrelated rows and the output looks
    // like a genuine comparison. Observed on T000, whose only key is MANDT.
    expect(() =>
      compareTableRows([row()], [row()], { keyFields: ['MANDT'] }),
    ).toThrow(/cannot be compared across systems/);
  });

  it('reports which fields differ, not merely that the row does', () => {
    const result = compareTableRows(
      [row({ PERIV: 'K1' })],
      [row({ PERIV: 'K4' })],
      { keyFields: ['MANDT', 'BUKRS'] },
    );
    expect(result.different).toEqual([
      {
        key: { BUKRS: '1000' },
        fields: [{ field: 'PERIV', source: 'K1', target: 'K4' }],
      },
    ]);
  });

  it('separates rows missing on either side', () => {
    const result = compareTableRows(
      [row({ BUKRS: 'A' }), row({ BUKRS: 'B' })],
      [row({ BUKRS: 'B' }), row({ BUKRS: 'C' })],
      { keyFields: ['MANDT', 'BUKRS'] },
    );
    expect(result.onlyInSource).toEqual([{ BUKRS: 'A' }]);
    expect(result.onlyInTarget).toEqual([{ BUKRS: 'C' }]);
    expect(result.identical).toBe(1);
  });

  it('honours ignore_fields without hiding that it did', () => {
    const result = compareTableRows(
      [row({ PERIV: 'K1' })],
      [row({ PERIV: 'K4' })],
      { keyFields: ['MANDT', 'BUKRS'], ignoreFields: ['periv'] },
    );
    expect(result.identical).toBe(1);
    expect(result.ignoredFields).toContain('PERIV');
    expect(result.comparedFields).not.toContain('PERIV');
  });

  it('compares columns present only on one side', () => {
    // A column added downstream and missing here is a real difference, and
    // taking the source's columns alone would hide it.
    const result = compareTableRows(
      [{ MANDT: '100', BUKRS: '1000' }],
      [{ MANDT: '100', BUKRS: '1000', NEWFLD: 'X' }],
      { keyFields: ['MANDT', 'BUKRS'] },
    );
    expect(result.different[0].fields).toEqual([
      { field: 'NEWFLD', source: '', target: 'X' },
    ]);
  });

  it('counts differing rows past the detail cap without listing them', () => {
    const source = Array.from({ length: 5 }, (_, i) =>
      row({ BUKRS: `B${i}`, PERIV: 'K1' }),
    );
    const target = source.map((r) => ({ ...r, PERIV: 'K4' }));
    const result = compareTableRows(source, target, {
      keyFields: ['MANDT', 'BUKRS'],
      maxDifferences: 2,
    });
    expect(result.different).toHaveLength(5);
    expect(result.different.filter((d) => d.fields.length > 0)).toHaveLength(2);
  });
});

describe('rowKey', () => {
  it('does not merge different rows whose key values run together', () => {
    // 'A' + 'B|C' and 'A|B' + 'C' are different rows; a separator-joined key
    // would collapse them into one.
    const a = rowKey({ X: 'A', Y: 'B|C' }, ['X', 'Y']);
    const b = rowKey({ X: 'A|B', Y: 'C' }, ['X', 'Y']);
    expect(a).not.toBe(b);
  });

  it('treats a missing field as empty rather than throwing', () => {
    expect(rowKey({}, ['X'])).toBe('0:');
  });
});

describe('summariseDifferences', () => {
  it('names the fields driving the differences', () => {
    const source = [
      row({ BUKRS: 'A', PERIV: 'K1' }),
      row({ BUKRS: 'B', PERIV: 'K1' }),
    ];
    const target = [
      row({ BUKRS: 'A', PERIV: 'K4' }),
      row({ BUKRS: 'B', PERIV: 'K4', BUTXT: 'Other' }),
    ];
    const summary = summariseDifferences(
      compareTableRows(source, target, { keyFields: ['MANDT', 'BUKRS'] }),
    );
    expect(summary.different).toBe(2);
    expect(summary.fields_driving_differences[0]).toEqual({
      field: 'PERIV',
      rows: 2,
    });
  });
});
