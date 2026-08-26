/**
 * Comparing the CONTENT of a table across systems.
 *
 * The fork already compares source across the landscape. But when a process
 * behaves differently in QAS or production and the code is identical, the
 * answer is almost always customizing, and nothing here could see it.
 *
 * Two decisions worth stating, because both are judgement rather than
 * mechanism:
 *
 * - `MANDT` is dropped from the key and from the comparison by default. Each
 *   connection runs in its own client, so keeping it would either be noise or,
 *   where the clients differ, would make every single row look unique.
 * - Nothing else is ignored unless the caller says so. Change-tracking fields
 *   do differ between systems constantly, but silently hiding fields would
 *   turn a real difference into an apparently clean result. They are reported,
 *   and `ignore_fields` is there to quiet them deliberately.
 */

/** A row as the SQL layer returns it: every column a string. */
export type TableRow = Record<string, string>;

export interface FieldDifference {
  field: string;
  source: string;
  target: string;
}

export interface RowDifference {
  key: Record<string, string>;
  fields: FieldDifference[];
}

export interface TableComparison {
  keyFields: string[];
  comparedFields: string[];
  ignoredFields: string[];
  sourceRows: number;
  targetRows: number;
  identical: number;
  onlyInSource: Array<Record<string, string>>;
  onlyInTarget: Array<Record<string, string>>;
  different: RowDifference[];
}

/** Client is per-connection, so it never distinguishes a row across systems. */
export const CLIENT_FIELD = 'MANDT';

const value = (row: TableRow, field: string) => String(row?.[field] ?? '');

/**
 * A stable identity for a row.
 *
 * Values are length-prefixed rather than joined by a separator: two key fields
 * holding `A` + `B|C` and `A|B` + `C` would otherwise produce the same key and
 * silently merge two different rows.
 */
export function rowKey(row: TableRow, keyFields: string[]): string {
  return keyFields
    .map((field) => {
      const raw = value(row, field);
      return `${raw.length}:${raw}`;
    })
    .join('');
}

function keyObject(row: TableRow, keyFields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of keyFields) out[field] = value(row, field);
  return out;
}

/**
 * Diff two sets of rows by key.
 *
 * Pure: no connection, no I/O. The whole judgement about what counts as a
 * difference lives here and is testable without a system.
 */
export function compareTableRows(
  sourceRows: TableRow[],
  targetRows: TableRow[],
  options: {
    keyFields: string[];
    /** Fields excluded from comparison but still reported as ignored. */
    ignoreFields?: string[];
    /** Cap on how many differing rows to detail. */
    maxDifferences?: number;
  },
): TableComparison {
  const keyFields = options.keyFields.filter((f) => f !== CLIENT_FIELD);
  // Without a key every row hashes to the same value, so rows get paired by
  // accident and the output looks like a real comparison. A table keyed only by
  // client cannot be matched across systems at all.
  if (keyFields.length === 0) {
    throw new Error(
      'No key fields left to match rows by. A table whose only key is the client cannot be compared across systems, since each system holds exactly one row per client. Pass key_fields if some other column identifies a row.',
    );
  }
  const ignored = new Set([
    CLIENT_FIELD,
    ...(options.ignoreFields ?? []).map((f) => f.toUpperCase()),
  ]);
  const maxDifferences = options.maxDifferences ?? 200;

  // Compare the union of both sides' columns. Taking only the source's would
  // hide a column that exists downstream and not in development.
  const allFields = new Set<string>();
  for (const row of sourceRows)
    for (const f of Object.keys(row)) allFields.add(f);
  for (const row of targetRows)
    for (const f of Object.keys(row)) allFields.add(f);

  const comparedFields = [...allFields]
    .filter((f) => !ignored.has(f) && !keyFields.includes(f))
    .sort();

  const targetByKey = new Map<string, TableRow>();
  for (const row of targetRows) targetByKey.set(rowKey(row, keyFields), row);

  const seen = new Set<string>();
  const onlyInSource: Array<Record<string, string>> = [];
  const different: RowDifference[] = [];
  let identical = 0;

  for (const row of sourceRows) {
    const key = rowKey(row, keyFields);
    seen.add(key);
    const match = targetByKey.get(key);
    if (!match) {
      onlyInSource.push(keyObject(row, keyFields));
      continue;
    }

    const fields: FieldDifference[] = [];
    for (const field of comparedFields) {
      const a = value(row, field);
      const b = value(match, field);
      if (a !== b) fields.push({ field, source: a, target: b });
    }

    if (fields.length === 0) {
      identical += 1;
    } else if (different.length < maxDifferences) {
      different.push({ key: keyObject(row, keyFields), fields });
    } else {
      // Counted but not detailed; the caller is told the cap was hit.
      different.push({ key: keyObject(row, keyFields), fields: [] });
    }
  }

  const onlyInTarget: Array<Record<string, string>> = [];
  for (const row of targetRows) {
    if (!seen.has(rowKey(row, keyFields))) {
      onlyInTarget.push(keyObject(row, keyFields));
    }
  }

  return {
    keyFields,
    comparedFields,
    ignoredFields: [...ignored].sort(),
    sourceRows: sourceRows.length,
    targetRows: targetRows.length,
    identical,
    onlyInSource,
    onlyInTarget,
    different,
  };
}

/**
 * Summarise which fields drive the differences.
 *
 * A table that differs in one field across 200 rows and one that differs in 40
 * fields across 5 rows are very different problems, and a flat list of rows
 * does not distinguish them.
 */
export function summariseDifferences(comparison: TableComparison) {
  const byField = new Map<string, number>();
  for (const row of comparison.different) {
    for (const field of row.fields) {
      byField.set(field.field, (byField.get(field.field) ?? 0) + 1);
    }
  }

  return {
    only_in_source: comparison.onlyInSource.length,
    only_in_target: comparison.onlyInTarget.length,
    different: comparison.different.length,
    identical: comparison.identical,
    fields_driving_differences: [...byField.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([field, rows]) => ({ field, rows })),
  };
}
