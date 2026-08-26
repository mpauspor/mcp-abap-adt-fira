/**
 * CompareTableAcrossSystems — customizing, not code.
 *
 * The landscape tools compare source. This compares content, because when a
 * process behaves differently in QAS or production and the code is identical,
 * the answer is almost always a configuration table.
 */

import type { IAbapConnection, ILogger } from '@mcp-abap-adt/interfaces';
import { getSecondaryConnection } from '../../../lib/adt/secondarySystem';
import {
  compareTableRows,
  summariseDifferences,
  type TableRow,
} from '../../../lib/adt/tableCompare';
import { createAdtClient } from '../../../lib/clients';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, SQL_MAX_LENGTH } from '../../../lib/utils';
import { parseSqlQueryXml } from '../../system/readonly/handleGetSqlQuery';

export const TOOL_DEFINITION = {
  name: 'CompareTableAcrossSystems',
  description:
    '[read-only] Compare the CONTENTS of a table between this system and another — customizing, not code. Answers "why does this behave differently in QAS?" when the code is identical. Reports rows missing on either side and rows whose fields differ, with the key of each. Key fields are read from the dictionary unless you pass key_fields. MANDT is excluded, since each connection runs in its own client. Use where_clause to scope a large table. Reads only; it never writes to either system.',
  inputSchema: {
    type: 'object',
    properties: {
      table_name: {
        type: 'string',
        description: 'Table to compare, e.g. T685A.',
      },
      target_system: {
        type: 'string',
        description:
          'Name of the system to compare against, as reported by ListSystems.',
      },
      where_clause: {
        type: 'string',
        description:
          'Optional filter applied in both systems, without the WHERE keyword, e.g. "KAPPL = \'V\'". Needed for any table too large to read whole.',
      },
      key_fields: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Override the key used to match rows. Defaults to the table key from the dictionary.',
      },
      ignore_fields: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Fields to exclude from comparison, e.g. change date and changed-by, which differ between systems constantly. Nothing is ignored unless named here.',
      },
      max_rows: {
        type: 'number',
        description:
          'Rows read per system, default 1000. If a side hits this cap the result is reported as incomplete rather than as a comparison.',
      },
      max_differences: {
        type: 'number',
        description: 'Differing rows detailed in the output, default 200.',
      },
      to_file: { type: 'string' },
      overwrite: { type: 'boolean' },
    },
    required: ['table_name', 'target_system'],
  },
};

interface Args {
  table_name?: string;
  target_system?: string;
  where_clause?: string;
  key_fields?: string[];
  ignore_fields?: string[];
  max_rows?: number;
  max_differences?: number;
}

function makeReader(connection: IAbapConnection, logger?: ILogger) {
  const client = createAdtClient(connection, logger);
  return async (sql: string, rows: number): Promise<TableRow[]> => {
    if (sql.length > SQL_MAX_LENGTH) {
      throw new Error(
        `The generated statement is ${sql.length} characters and SAP accepts at most ${SQL_MAX_LENGTH}. Shorten where_clause.`,
      );
    }
    const response = await client
      .getUtils()
      .getSqlQuery({ sql_query: sql, row_number: rows });
    if (response.status !== 200 || !response.data) {
      throw new Error(`Query failed with status ${response.status}.`);
    }
    return parseSqlQueryXml(response.data, sql, rows, logger)
      .rows as TableRow[];
  };
}

export async function handleCompareTableAcrossSystems(
  context: HandlerContext,
  args: Args,
) {
  const { connection, logger } = context;

  try {
    const table = String(args?.table_name ?? '')
      .trim()
      .toUpperCase();
    const targetName = String(args?.target_system ?? '').trim();
    if (!table || !targetName) {
      return return_error(
        new Error('table_name and target_system are both required.'),
      );
    }

    const maxRows = Math.max(1, Math.min(args.max_rows ?? 1000, 20000));
    const readSource = makeReader(connection, logger);

    // The key comes from the dictionary unless the caller overrides it. Getting
    // this wrong does not fail loudly — it silently matches the wrong rows.
    let keyFields = (args.key_fields ?? []).map((f) => f.toUpperCase());
    if (keyFields.length === 0) {
      const keyRows = await readSource(
        `SELECT FIELDNAME, POSITION FROM DD03L WHERE TABNAME = '${table}' AND KEYFLAG = 'X' AND AS4LOCAL = 'A'`,
        50,
      );
      keyFields = keyRows
        .sort((a, b) => Number(a.POSITION ?? 0) - Number(b.POSITION ?? 0))
        .map((row) => String(row.FIELDNAME ?? '').trim())
        .filter(Boolean);
    }

    if (keyFields.length === 0) {
      return return_error(
        new Error(
          `No key fields found for ${table}. It may not exist, or may not be a transparent table. Pass key_fields to compare it anyway.`,
        ),
      );
    }

    const where = args.where_clause?.trim();
    const select = `SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''}`;

    const targetConnection = getSecondaryConnection(targetName, logger);
    const readTarget = makeReader(targetConnection, logger);

    // Sequential: one ADT session will not run two data-preview queries at once.
    const sourceRows = await readSource(select, maxRows);
    const targetRows = await readTarget(select, maxRows);

    const comparison = compareTableRows(sourceRows, targetRows, {
      keyFields,
      ignoreFields: args.ignore_fields,
      maxDifferences: args.max_differences,
    });

    const notes: string[] = [];
    // A truncated read is not a comparison. Saying nothing here would report
    // rows as missing when they were simply never fetched.
    if (sourceRows.length >= maxRows || targetRows.length >= maxRows) {
      notes.push(
        `At least one system returned the full ${maxRows}-row cap, so the two sides are not comparable: rows beyond the cap look "missing" when they were never read. Narrow it with where_clause, or raise max_rows.`,
      );
    }
    if (comparison.different.some((row) => row.fields.length === 0)) {
      notes.push(
        `More rows differ than the ${args.max_differences ?? 200} detailed here; the rest are counted but not listed.`,
      );
    }

    const truncated =
      sourceRows.length >= maxRows || targetRows.length >= maxRows;

    logger?.info?.(
      `[table-compare] ${table} vs ${targetName}: ${comparison.onlyInSource.length} only here, ${comparison.onlyInTarget.length} only there, ${comparison.different.length} differing`,
    );

    return {
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              table,
              target_system: targetName,
              where: where || null,
              comparable: !truncated,
              key_fields: comparison.keyFields,
              ignored_fields: comparison.ignoredFields,
              rows_read: {
                source: comparison.sourceRows,
                target: comparison.targetRows,
              },
              summary: summariseDifferences(comparison),
              only_in_source: comparison.onlyInSource.slice(0, 200),
              only_in_target: comparison.onlyInTarget.slice(0, 200),
              differences: comparison.different.filter(
                (row) => row.fields.length > 0,
              ),
              ...(notes.length ? { notes } : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (error: any) {
    logger?.error?.(`[table-compare] failed: ${error?.message}`);
    return return_error(error);
  }
}
