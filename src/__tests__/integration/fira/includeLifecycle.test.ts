/**
 * Integration tests for the include write path and post-write verification.
 *
 * This is the only Fira suite that WRITES to SAP. Everything it creates lives in
 * $TMP under a ZZFIRA_T_* name and is deleted in afterAll, including after a
 * failure — a leftover locked include would block the next run.
 *
 * The behaviour under test is the one that motivated the fork: UpdateProgram
 * reported success while writing nothing to an include, because it addressed the
 * program resource. Both halves are asserted — that the include really is
 * written, and that the program tool refuses rather than lying.
 *
 * Run: npm test -- --testPathPatterns=fira/includeLifecycle
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleUpdateInclude } from '../../../handlers/include/high/handleUpdateInclude';
import { handleDeleteProgram } from '../../../handlers/program/high/handleDeleteProgram';
import { handleUpdateProgram } from '../../../handlers/program/high/handleUpdateProgram';
import {
  createIncludeObject,
  isInclude,
  readIncludeSource,
} from '../../../lib/adt/includeSource';
import { withSourceFromFile } from '../../../lib/fileTransfer';
import { getTimeout } from '../helpers/configHelpers';
import { firaContext, unwrap } from '../helpers/firaContext';

const INCLUDE = 'ZZFIRA_T_INC';
const PACKAGE = '$TMP';

const sourceV1 = `*&--- ${INCLUDE} v1
DATA: gv_fira_v1 TYPE i VALUE 1.
`;
const sourceV2 = `*&--- ${INCLUDE} v2
DATA: gv_fira_v2 TYPE string VALUE 'segunda'.
`;

let workDir: string;

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fira-include-'));
  const context = await firaContext();
  try {
    await createIncludeObject(context.connection, {
      includeName: INCLUDE,
      packageName: PACKAGE,
      description: 'Integration test include - safe to delete',
    });
  } catch (error: any) {
    const body = String(error?.response?.data ?? error?.message ?? '');
    // Left over from an interrupted run: reuse it rather than fail.
    if (!/already exists|schon vorhanden/i.test(body)) throw error;
  }
}, getTimeout('long'));

afterAll(async () => {
  fs.rmSync(workDir, { recursive: true, force: true });
  const context = await firaContext();
  try {
    await handleDeleteProgram(context, { program_name: INCLUDE });
  } catch {
    /* best effort: a failed cleanup must not mask a test result */
  }
}, getTimeout('long'));

describe('UpdateInclude', () => {
  it(
    'writes the source and confirms it by reading it back',
    async () => {
      const context = await firaContext();
      const { isError, payload } = unwrap(
        await handleUpdateInclude(context, {
          include_name: INCLUDE,
          source_code: sourceV1,
        }),
      );

      expect(isError).toBe(false);
      // Not just "no exception was thrown".
      expect(payload.write_verified).toBe(true);
      expect(payload.steps_completed).toContain('verify_read_back');

      const onServer = await readIncludeSource(context.connection, INCLUDE);
      expect(onServer).toContain('gv_fira_v1');
    },
    getTimeout('long'),
  );

  it(
    'replaces the previous content rather than appending',
    async () => {
      const context = await firaContext();
      const { isError } = unwrap(
        await handleUpdateInclude(context, {
          include_name: INCLUDE,
          source_code: sourceV2,
        }),
      );

      expect(isError).toBe(false);
      const onServer = await readIncludeSource(context.connection, INCLUDE);
      expect(onServer).toContain('gv_fira_v2');
      expect(onServer).not.toContain('gv_fira_v1');
    },
    getTimeout('long'),
  );

  it(
    'accepts the source from a local file',
    async () => {
      const context = await firaContext();
      const file = path.join(workDir, 'include.abap');
      fs.writeFileSync(file, `*&--- desde fichero\nDATA: gv_fichero TYPE c.\n`);

      const wrapped = withSourceFromFile('source_code', (args: any) =>
        handleUpdateInclude(context, args),
      );
      const { isError, payload } = unwrap(
        await wrapped({ include_name: INCLUDE, source_path: file }),
      );

      expect(isError).toBe(false);
      expect(payload.write_verified).toBe(true);

      const onServer = await readIncludeSource(context.connection, INCLUDE);
      expect(onServer).toContain('gv_fichero');
    },
    getTimeout('long'),
  );
});

describe('UpdateProgram guard', () => {
  it(
    'refuses an include and points at the right tool',
    async () => {
      const context = await firaContext();
      const before = await readIncludeSource(context.connection, INCLUDE);

      const { isError, payload } = unwrap(
        await handleUpdateProgram(context, {
          program_name: INCLUDE,
          source_code: '* esto no debe escribirse nunca',
        }),
      );

      expect(isError).toBe(true);
      expect(String(payload)).toMatch(/UpdateInclude/);

      // The whole point: the include must be untouched.
      const after = await readIncludeSource(context.connection, INCLUDE);
      expect(after).toBe(before);
      expect(after).not.toContain('no debe escribirse');
    },
    getTimeout('long'),
  );
});

describe('isInclude', () => {
  it(
    'recognises an include and does not mistake a program for one',
    async () => {
      const context = await firaContext();

      expect(await isInclude(context.connection, INCLUDE)).toBe(true);
      // RSUSR200 is a report present on every system.
      expect(await isInclude(context.connection, 'RSUSR200')).toBe(false);
    },
    getTimeout('long'),
  );
});
