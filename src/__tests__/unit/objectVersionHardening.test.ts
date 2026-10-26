/**
 * Unit tests (T-002 / object-version spec §5.1): object version hardening.
 *
 * Verifies:
 * - assertVersionContentUri accepts safe relative ADT paths and rejects
 *   unsafe, malformed, non-string, traversal, and over-length URIs.
 * - assertNotHtmlSource detects login redirects and error pages without false
 *   positives on legitimate ABAP source code.
 * - Generic and per-object handlers validate URIs before calling createAdtClient,
 *   reject HTML responses, and produce standardized 404/406 error messages.
 */

const mockClassGetVersions = jest.fn();
const mockClassGetVersionSource = jest.fn();
const mockGetClass = jest.fn();
const mockCreateAdtClient = jest.fn();

jest.mock('../../lib/clients', () => ({
  createAdtClient: (...args: any[]) => mockCreateAdtClient(...args),
}));

import { AdtObjectErrorCodes } from '@mcp-abap-adt/interfaces';
import { buildObjectVersionTools } from '../../handlers/common/high/objectVersionTools';
import { handleGetObjectVersionDiff } from '../../handlers/common/readonly/handleGetObjectVersionDiff';
import { handleGetObjectVersionSource } from '../../handlers/common/readonly/handleGetObjectVersionSource';
import {
  TOOL_DEFINITION as getObjectVersionsToolDef,
  handleGetObjectVersions,
} from '../../handlers/common/readonly/handleGetObjectVersions';
import {
  assertNotHtmlSource,
  assertVersionContentUri,
} from '../../handlers/common/readonly/resolveVersionedObject';

const ctx = { connection: {}, logger: undefined } as any;

function errorText(result: any): string {
  return (
    (result.content.find((c: any) => c.type === 'text') as any)?.text || ''
  );
}

function findTool(name: string) {
  const entry = buildObjectVersionTools().find(
    (e) => e.toolDefinition.name === name,
  );
  if (!entry) throw new Error(`Tool ${name} not found`);
  return entry;
}

beforeEach(() => {
  mockClassGetVersions.mockReset();
  mockClassGetVersionSource.mockReset();
  mockGetClass.mockReset();
  mockCreateAdtClient.mockReset();

  mockGetClass.mockReturnValue({
    getVersions: mockClassGetVersions,
    getVersionSource: mockClassGetVersionSource,
  });
  mockCreateAdtClient.mockReturnValue({
    getClass: mockGetClass,
  });
});

describe('assertVersionContentUri (§3.1, §5.1)', () => {
  it('accepts valid relative ADT paths and returns the uri', () => {
    const validUris = [
      '/sap/bc/adt/oo/classes/zcl_x/source/main?version=00001',
      '/sap/bc/adt/programs/programs/ztest/source/main',
      '/sap/bc/adt/ddic/ddl/sources/zi_view/source/main?version=00003&foo=bar',
      '/sap/bc/adt/x;version=00001',
      '/sap/bc/adt/oo/classes/zcl_x/includes/main/versions/00001/content',
      '/sap/bc/adt/programs/programs/z_x/source/main?version=00001',
    ];

    for (const uri of validUris) {
      expect(assertVersionContentUri(uri, 'content_uri')).toBe(uri);
    }
  });

  it('rejects invalid URIs with exact message format', () => {
    const cases: Array<{ input: unknown; field: string; expectedGot: string }> =
      [
        {
          input: 'http://attacker.example/sap/bc/adt/x',
          field: 'content_uri',
          expectedGot: 'http://attacker.example/sap/bc/adt/x',
        },
        {
          input: 'https://attacker.example/sap/bc/adt/x',
          field: 'content_uri',
          expectedGot: 'https://attacker.example/sap/bc/adt/x',
        },
        {
          input: '//attacker.example/sap/bc/adt/x',
          field: 'content_uri',
          expectedGot: '//attacker.example/sap/bc/adt/x',
        },
        {
          input: '@attacker.example/x',
          field: 'content_uri',
          expectedGot: '@attacker.example/x',
        },
        {
          input: '.attacker.example/x',
          field: 'content_uri',
          expectedGot: '.attacker.example/x',
        },
        {
          input: 'sap/bc/adt/x',
          field: 'content_uri',
          expectedGot: 'sap/bc/adt/x',
        },
        {
          input: '/sap/bc/bsp/x',
          field: 'content_uri',
          expectedGot: '/sap/bc/bsp/x',
        },
        {
          input: '/sap/bc/adt/..',
          field: 'content_uri',
          expectedGot: '/sap/bc/adt/..',
        },
        {
          input: '/sap/bc/adt/%2e%2e',
          field: 'content_uri',
          expectedGot: '/sap/bc/adt/%2e%2e',
        },
        {
          input: '/sap/bc/adt/.',
          field: 'content_uri',
          expectedGot: '/sap/bc/adt/.',
        },
        {
          input: '/sap/bc/adt/%2e',
          field: 'content_uri',
          expectedGot: '/sap/bc/adt/%2e',
        },
        {
          input: '/sap/bc/adt/x/../../etc',
          field: 'content_uri',
          expectedGot: '/sap/bc/adt/x/../../etc',
        },
        {
          input: '/sap/bc/adt//x',
          field: 'content_uri',
          expectedGot: '/sap/bc/adt//x',
        },
        {
          input: '/sap/bc/adt/x\\y',
          field: 'content_uri',
          expectedGot: '/sap/bc/adt/x\\y',
        },
        {
          input: '/sap/bc/adt/x#frag',
          field: 'content_uri',
          expectedGot: '/sap/bc/adt/x#frag',
        },
        {
          input: '/sap/bc/adt/x?v=1#frag',
          field: 'content_uri',
          expectedGot: '/sap/bc/adt/x?v=1#frag',
        },
        {
          input: '/sap/bc/adt/x%zz',
          field: 'content_uri',
          expectedGot: '/sap/bc/adt/x%zz',
        },
        {
          input: '/sap/bc/adt/x y',
          field: 'content_uri',
          expectedGot: '/sap/bc/adt/x y',
        },
        {
          input: '/sap/bc/adt/x\ty', // TAB (stripped by sanitizeUriForError)
          field: 'content_uri',
          expectedGot: '/sap/bc/adt/xy',
        },
        {
          input: '/sap/bc/adt/x\ry', // CR (stripped by sanitizeUriForError)
          field: 'content_uri',
          expectedGot: '/sap/bc/adt/xy',
        },
        {
          input: '/sap/bc/adt/x\ny', // LF (stripped by sanitizeUriForError)
          field: 'content_uri',
          expectedGot: '/sap/bc/adt/xy',
        },
        {
          input: '/sap/bc/adt/x\x7fy', // DEL U+007F
          field: 'content_uri',
          expectedGot: '/sap/bc/adt/x\x7fy',
        },
        {
          input: '',
          field: 'content_uri',
          expectedGot: '',
        },
        {
          input: null,
          field: 'content_uri',
          expectedGot: 'null',
        },
        {
          input: undefined,
          field: 'content_uri',
          expectedGot: 'undefined',
        },
        {
          input: '/sap/bc/adt/' + 'a'.repeat(2049 - 12), // exact 2049 length > 2048
          field: 'content_uri',
          expectedGot: ('/sap/bc/adt/' + 'a'.repeat(2049 - 12)).slice(0, 80),
        },
        {
          input: '/sap/bc/adt/' + 'a'.repeat(2040), // total length 2052 > 2048
          field: 'content_uri',
          expectedGot: ('/sap/bc/adt/' + 'a'.repeat(2040)).slice(0, 80),
        },
      ];

    for (const c of cases) {
      expect(() => assertVersionContentUri(c.input, c.field)).toThrow(
        `${c.field} must be a relative ADT path starting with /sap/bc/adt/, as returned in a version entry's contentUri (got: ${c.expectedGot}).`,
      );
    }
  });

  it('truncates got value to 80 chars without ellipsis', () => {
    const longBad = 'bad-prefix-' + 'z'.repeat(120);
    expect(() => assertVersionContentUri(longBad, 'content_uri_from')).toThrow(
      `content_uri_from must be a relative ADT path starting with /sap/bc/adt/, as returned in a version entry's contentUri (got: ${longBad.slice(0, 80)}).`,
    );
  });
});

describe('assertNotHtmlSource (§3.4, §5.1)', () => {
  it('throws on HTML content', () => {
    const htmlExamples = [
      '<!DOCTYPE html><html><body>Error</body></html>',
      '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><html>...</html>',
      '<html><body>Error</body></html>',
      '  <html lang="en"><body>Logon</body></html>',
      '\n\t<!doctype html><html>',
    ];

    for (const html of htmlExamples) {
      expect(() =>
        assertNotHtmlSource(
          html,
          'content_uri',
          '/sap/bc/adt/oo/classes/z/source/main',
        ),
      ).toThrow(
        'SAP returned an HTML page instead of source for content_uri (/sap/bc/adt/oo/classes/z/source/main). The session may have expired, or the URI is not a version resource.',
      );
    }
  });

  it('uses field name as fallback when contentUri is omitted', () => {
    expect(() =>
      assertNotHtmlSource('<!DOCTYPE html><html>', 'content_uri'),
    ).toThrow(
      'SAP returned an HTML page instead of source for content_uri (content_uri). The session may have expired, or the URI is not a version resource.',
    );
  });

  it('does not throw for null, undefined, empty, or normal ABAP sources', () => {
    expect(() => assertNotHtmlSource(null, 'content_uri')).not.toThrow();
    expect(() => assertNotHtmlSource(undefined, 'content_uri')).not.toThrow();
    expect(() => assertNotHtmlSource('', 'content_uri')).not.toThrow();
    expect(() =>
      assertNotHtmlSource("REPORT ztest.\nWRITE: '<html>'.", 'content_uri'),
    ).not.toThrow();
    expect(() =>
      assertNotHtmlSource('* comment\n<html>', 'content_uri'),
    ).not.toThrow();
    expect(() =>
      assertNotHtmlSource(
        'CLASS zcl_foo DEFINITION.\nENDCLASS.',
        'content_uri',
      ),
    ).not.toThrow();
  });
});

describe('Handler integration: URI validation upfront (§3.1, §5.1)', () => {
  it('handleGetObjectVersionSource rejects invalid URI before createAdtClient', async () => {
    const result = await handleGetObjectVersionSource(ctx, {
      object_type: 'class',
      content_uri: 'http://attacker.example/sap/bc/adt/x',
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(
      "content_uri must be a relative ADT path starting with /sap/bc/adt/, as returned in a version entry's contentUri",
    );
    expect(mockCreateAdtClient).not.toHaveBeenCalled();
  });

  it('handleGetObjectVersionDiff validates content_uri_from first before createAdtClient', async () => {
    const result = await handleGetObjectVersionDiff(ctx, {
      object_type: 'class',
      content_uri_from: 'http://attacker.example/sap/bc/adt/x',
      content_uri_to: '/sap/bc/adt/oo/classes/z/source/main?version=00002',
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(
      "content_uri_from must be a relative ADT path starting with /sap/bc/adt/, as returned in a version entry's contentUri",
    );
    expect(mockCreateAdtClient).not.toHaveBeenCalled();
  });

  it('handleGetObjectVersionDiff validates content_uri_to second before createAdtClient', async () => {
    const result = await handleGetObjectVersionDiff(ctx, {
      object_type: 'class',
      content_uri_from: '/sap/bc/adt/oo/classes/z/source/main?version=00001',
      content_uri_to: 'http://attacker.example/sap/bc/adt/y',
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(
      "content_uri_to must be a relative ADT path starting with /sap/bc/adt/, as returned in a version entry's contentUri",
    );
    expect(mockCreateAdtClient).not.toHaveBeenCalled();
  });

  it('GetClassVersionSource validates URI before createAdtClient', async () => {
    const tool = findTool('GetClassVersionSource');
    const result = await tool.handler(ctx, {
      content_uri: '/sap/bc/bsp/not-adt',
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(
      "content_uri must be a relative ADT path starting with /sap/bc/adt/, as returned in a version entry's contentUri",
    );
    expect(mockCreateAdtClient).not.toHaveBeenCalled();
  });

  it('GetClassVersionDiff validates both URIs before createAdtClient', async () => {
    const tool = findTool('GetClassVersionDiff');
    const result = await tool.handler(ctx, {
      content_uri_from: '/sap/bc/adt/oo/classes/z/source/main?version=00001',
      content_uri_to: '/sap/bc/bsp/invalid',
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(
      "content_uri_to must be a relative ADT path starting with /sap/bc/adt/, as returned in a version entry's contentUri",
    );
    expect(mockCreateAdtClient).not.toHaveBeenCalled();
  });
});

describe('Handler integration: HTML guard (§3.4, §5.1)', () => {
  it('handleGetObjectVersionSource rejects HTML source response', async () => {
    mockClassGetVersionSource.mockResolvedValue(
      '<!DOCTYPE html><html><body>Session Expired</body></html>',
    );

    const result = await handleGetObjectVersionSource(ctx, {
      object_type: 'class',
      content_uri: '/sap/bc/adt/oo/classes/z/source/main?version=00001',
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(
      'SAP returned an HTML page instead of source for content_uri (/sap/bc/adt/oo/classes/z/source/main?version=00001). The session may have expired, or the URI is not a version resource.',
    );
  });

  it('GetClassVersionSource rejects HTML source response', async () => {
    mockClassGetVersionSource.mockResolvedValue(
      '<html><body>Logon</body></html>',
    );

    const tool = findTool('GetClassVersionSource');
    const result = await tool.handler(ctx, {
      content_uri: '/sap/bc/adt/oo/classes/z/source/main?version=00001',
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(
      'SAP returned an HTML page instead of source for content_uri (/sap/bc/adt/oo/classes/z/source/main?version=00001).',
    );
  });

  it('handleGetObjectVersionDiff rejects HTML source in content_uri_from or content_uri_to', async () => {
    mockClassGetVersionSource
      .mockResolvedValueOnce('<html><body>Error 1</body></html>')
      .mockResolvedValueOnce('CLASS z DEFINITION.');

    const result = await handleGetObjectVersionDiff(ctx, {
      object_type: 'class',
      content_uri_from: '/sap/bc/adt/oo/classes/z/source/main?version=00001',
      content_uri_to: '/sap/bc/adt/oo/classes/z/source/main?version=00002',
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(
      'SAP returned an HTML page instead of source for content_uri_from (/sap/bc/adt/oo/classes/z/source/main?version=00001).',
    );
  });
});

describe('Handler integration: Standardized 404/406 error messages (§3.2, §3.3, §3.5)', () => {
  const unsupportedError = Object.assign(new Error('not supported'), {
    code: AdtObjectErrorCodes.UNSUPPORTED_OPERATION,
  });

  it('handleGetObjectVersions returns standardized message on UNSUPPORTED_OPERATION', async () => {
    mockClassGetVersions.mockRejectedValue(unsupportedError);

    const result = await handleGetObjectVersions(ctx, {
      object_type: 'class',
      object_name: 'zcl_test',
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe(
      'No version history for class ZCL_TEST: the object does not exist, or this system offers no version resource for this object type (SAP answered 404/406).',
    );
  });

  it('GetClassVersions returns standardized message on UNSUPPORTED_OPERATION', async () => {
    mockClassGetVersions.mockRejectedValue(unsupportedError);

    const tool = findTool('GetClassVersions');
    const result = await tool.handler(ctx, { class_name: 'zcl_test' });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe(
      'No version history for class ZCL_TEST: the object does not exist, or this system offers no version resource for this object type (SAP answered 404/406).',
    );
  });

  it('handleGetObjectVersionSource returns standardized message on UNSUPPORTED_OPERATION', async () => {
    mockClassGetVersionSource.mockRejectedValue(unsupportedError);

    const result = await handleGetObjectVersionSource(ctx, {
      object_type: 'class',
      content_uri: '/sap/bc/adt/oo/classes/z/source/main?version=00001',
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe(
      'No version source at /sap/bc/adt/oo/classes/z/source/main?version=00001 (SAP answered 404/406).',
    );
  });

  it('GetClassVersionSource returns standardized message on UNSUPPORTED_OPERATION', async () => {
    mockClassGetVersionSource.mockRejectedValue(unsupportedError);

    const tool = findTool('GetClassVersionSource');
    const result = await tool.handler(ctx, {
      content_uri: '/sap/bc/adt/oo/classes/z/source/main?version=00001',
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe(
      'No version source at /sap/bc/adt/oo/classes/z/source/main?version=00001 (SAP answered 404/406).',
    );
  });

  it('handleGetObjectVersionDiff returns standardized message on UNSUPPORTED_OPERATION', async () => {
    mockClassGetVersionSource.mockRejectedValue(unsupportedError);

    const result = await handleGetObjectVersionDiff(ctx, {
      object_type: 'class',
      content_uri_from: '/sap/bc/adt/oo/classes/z/source/main?version=00001',
      content_uri_to: '/sap/bc/adt/oo/classes/z/source/main?version=00002',
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe(
      'No version source for one of the two content URIs (SAP answered 404/406).',
    );
  });

  it('GetClassVersionDiff returns standardized message on UNSUPPORTED_OPERATION', async () => {
    mockClassGetVersionSource.mockRejectedValue(unsupportedError);

    const tool = findTool('GetClassVersionDiff');
    const result = await tool.handler(ctx, {
      content_uri_from: '/sap/bc/adt/oo/classes/z/source/main?version=00001',
      content_uri_to: '/sap/bc/adt/oo/classes/z/source/main?version=00002',
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe(
      'No version source for one of the two content URIs (SAP answered 404/406).',
    );
  });
});

describe('tool description contract (SPEC §3.2, §5.1)', () => {
  it('GetObjectVersions description contains contentUri and content_uri with exact phrasing', () => {
    expect(getObjectVersionsToolDef.description).toContain('contentUri');
    expect(getObjectVersionsToolDef.description).toContain('content_uri');
    expect(getObjectVersionsToolDef.description).toContain(
      'an opaque contentUri (pass it as content_uri to GetObjectVersionSource)',
    );
  });

  it('all 9 per-type Get<X>Versions descriptions contain contentUri and content_uri with exact phrasing', () => {
    const allTools = buildObjectVersionTools();
    const versionTools = allTools.filter(
      (t) =>
        t.toolDefinition.name.endsWith('Versions') &&
        !t.toolDefinition.name.endsWith('VersionSource') &&
        !t.toolDefinition.name.endsWith('VersionDiff'),
    );

    expect(versionTools).toHaveLength(9);

    const expectedNames = [
      'GetClassVersions',
      'GetProgramVersions',
      'GetInterfaceVersions',
      'GetFunctionModuleVersions',
      'GetTableVersions',
      'GetStructureVersions',
      'GetDdlVersions',
      'GetBehaviorDefinitionVersions',
      'GetMetadataExtensionVersions',
    ];

    expect(versionTools.map((t) => t.toolDefinition.name).sort()).toEqual(
      expectedNames.sort(),
    );

    for (const tool of versionTools) {
      const desc = tool.toolDefinition.description;
      expect(desc).toContain('contentUri');
      expect(desc).toContain('content_uri');
      const baseName = tool.toolDefinition.name.replace(/Versions$/, '');
      expect(desc).toContain(
        `an opaque contentUri (pass it as content_uri to ${baseName}VersionSource)`,
      );
    }
  });
});
