/**
 * Integration tests for reading and writing source through local files.
 *
 * Covers the round trip that motivated the feature — read an object too large
 * for a tool call to disk, write it back from disk — plus the guard rails,
 * which are the part most likely to rot silently.
 *
 * Run: npm test -- --testPathPatterns=fira/fileTransfer
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleGetProgram } from '../../../handlers/program/high/handleGetProgram';
import {
  addOutputFileToSchema,
  addSourcePathToSchema,
  readSourceFile,
  shouldOfferOutputFile,
  withOutputToFile,
  withSourceFromFile,
  writeOutputFile,
} from '../../../lib/fileTransfer';
import { getTimeout } from '../helpers/configHelpers';
import { firaContext, unwrap } from '../helpers/firaContext';

/** A program every SAP system has, so no fixture is needed. */
const STANDARD_PROGRAM = 'RSUSR200';

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fira-filetransfer-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('readSourceFile', () => {
  it('strips a UTF-8 BOM', () => {
    // A BOM before REPORT is a syntax error the editor that wrote it hides.
    const file = path.join(workDir, 'bom.abap');
    fs.writeFileSync(file, `﻿REPORT z_con_bom.\n`, 'utf8');

    const source = readSourceFile(file);
    expect(source.charCodeAt(0)).not.toBe(0xfeff);
    expect(source.startsWith('REPORT')).toBe(true);
  });

  it('names the resolved path when the file is missing', () => {
    expect(() => readSourceFile(path.join(workDir, 'no-existe.abap'))).toThrow(
      /not found/i,
    );
  });

  it('rejects a directory', () => {
    expect(() => readSourceFile(workDir)).toThrow(/not a file/i);
  });
});

describe('writeOutputFile', () => {
  it('creates missing directories', () => {
    const file = path.join(workDir, 'nueva', 'carpeta', 'salida.txt');
    const written = writeOutputFile(file, 'hola', false);

    expect(fs.existsSync(file)).toBe(true);
    expect(written.bytes).toBe(4);
  });

  it('refuses to overwrite silently, and says how big the victim is', () => {
    const file = path.join(workDir, 'existente.txt');
    fs.writeFileSync(file, 'contenido previo importante', 'utf8');

    expect(() => writeOutputFile(file, 'nuevo', false)).toThrow(/overwrite/i);
    expect(() => writeOutputFile(file, 'nuevo', false)).toThrow(/27 bytes/);
    // The original must survive the refusal.
    expect(fs.readFileSync(file, 'utf8')).toBe('contenido previo importante');
  });

  it('replaces the file when told to', () => {
    const file = path.join(workDir, 'reemplazable.txt');
    fs.writeFileSync(file, 'viejo', 'utf8');

    writeOutputFile(file, 'nuevo', true);
    expect(fs.readFileSync(file, 'utf8')).toBe('nuevo');
  });

  it('counts lines, not just bytes', () => {
    const file = path.join(workDir, 'lineas.txt');
    const written = writeOutputFile(file, 'a\nb\nc', false);
    expect(written.lines).toBe(3);
  });
});

describe('schema augmentation', () => {
  it('only offers to_file where output can be large', () => {
    expect(shouldOfferOutputFile('GetProgram')).toBe(true);
    expect(shouldOfferOutputFile('ComparePackageAcrossLandscape')).toBe(true);
    // Adding it everywhere would cost context on every request.
    expect(shouldOfferOutputFile('DeleteClass')).toBe(false);
    expect(shouldOfferOutputFile('UpdateProgram')).toBe(false);
  });

  it('makes the source argument optional once a file can supply it', () => {
    const schema = {
      type: 'object',
      properties: { program_name: {}, source_code: {} },
      required: ['program_name', 'source_code'],
    };

    const augmented = addSourcePathToSchema(schema, 'source_code');
    expect(augmented.properties.source_path).toBeDefined();
    expect(augmented.required).toEqual(['program_name']);
  });

  it('adds to_file and overwrite together', () => {
    const augmented = addOutputFileToSchema({
      type: 'object',
      properties: {},
    });
    expect(augmented.properties.to_file).toBeDefined();
    expect(augmented.properties.overwrite).toBeDefined();
  });
});

describe('withSourceFromFile', () => {
  it('refuses both a file and inline source rather than picking one', async () => {
    // Guessing wrong writes the wrong code into SAP.
    const handler = jest.fn();
    const wrapped = withSourceFromFile('source_code', handler);

    const result: any = await wrapped({
      source_code: '* inline',
      source_path: path.join(workDir, 'cualquiera.abap'),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/only one/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it('feeds the file contents into the handler argument', async () => {
    const file = path.join(workDir, 'fuente.abap');
    fs.writeFileSync(file, 'REPORT z_desde_fichero.', 'utf8');

    const handler = jest
      .fn()
      .mockResolvedValue({ isError: false, content: [] });
    const wrapped = withSourceFromFile('source_code', handler);

    await wrapped({ program_name: 'Z_X', source_path: file });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ source_code: 'REPORT z_desde_fichero.' }),
    );
  });

  it('leaves a call without source_path untouched', async () => {
    const handler = jest
      .fn()
      .mockResolvedValue({ isError: false, content: [] });
    const wrapped = withSourceFromFile('source_code', handler);

    await wrapped({ program_name: 'Z_X', source_code: '* inline' });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ source_code: '* inline' }),
    );
  });
});

describe('withOutputToFile', () => {
  it('does not write the file when the call failed', async () => {
    // An error in the caller's source file is a surprising place to find it.
    const file = path.join(workDir, 'no-debe-existir.txt');
    const handler = jest.fn().mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'algo falló' }],
    });

    const result: any = await withOutputToFile(handler)({ to_file: file });

    expect(result.isError).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('extracts the source instead of writing the JSON envelope', async () => {
    const file = path.join(workDir, 'extraida.abap');
    const handler = jest.fn().mockResolvedValue({
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            program_name: 'Z_X',
            program_data: 'REPORT z_x.',
          }),
        },
      ],
    });

    const result: any = await withOutputToFile(handler)({ to_file: file });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.content).toBe('source');
    expect(fs.readFileSync(file, 'utf8')).toBe('REPORT z_x.');
  });

  it('writes the whole output when there is no recognisable source, and says so', async () => {
    const file = path.join(workDir, 'entera.json');
    const handler = jest.fn().mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ rows: [1, 2, 3] }) }],
    });

    const result: any = await withOutputToFile(handler)({ to_file: file });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.content).toBe('full tool output');
    expect(fs.readFileSync(file, 'utf8')).toContain('rows');
  });
});

describe('round trip against SAP', () => {
  it(
    'writes a real program to disk as editable ABAP',
    async () => {
      const context = await firaContext();
      const file = path.join(workDir, 'programa.abap');

      const wrapped = withOutputToFile((args: any) =>
        handleGetProgram(context, args),
      );
      const { isError, payload } = unwrap(
        await wrapped({ program_name: STANDARD_PROGRAM, to_file: file }),
      );

      expect(isError).toBe(false);
      expect(payload.content).toBe('source');
      expect(payload.bytes).toBeGreaterThan(0);

      // The file must be ABAP a developer can edit, not JSON with the code
      // escaped inside it.
      const onDisk = fs.readFileSync(file, 'utf8');
      expect(onDisk).not.toMatch(/^\s*\{/);
      expect(onDisk.toUpperCase()).toContain('REPORT');

      // And it must round-trip back through the read side unchanged.
      expect(readSourceFile(file)).toBe(onDisk);
    },
    getTimeout('long'),
  );
});
