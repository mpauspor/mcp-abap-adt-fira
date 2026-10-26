/**
 * Integration test for the Object Version ReadOnly and HighLevel handlers.
 *
 * Covers the object-version spec §5.2:
 * - Additional cases:
 *   - Invalid content_uri (@attacker.example/x) fails upfront with §3.1 message.
 *   - missing_object_name as class fails with standardized 404/406 message (U6).
 * - Per enabled case across all 9 versioned object types:
 *   1. GetObjectVersions lists versions, verifies min_versions, or logs NO_VERSION_RESOURCE on standardized 404/406 (U2).
 *   2. Every entry: non-empty versionId, contentUri validated with assertVersionContentUri (U1).
 *   3. GetObjectVersionSource reads non-empty source and asserts not HTML.
 *   4. If >= 2 versions, GetObjectVersionDiff from last entry to first.
 *   5. Matching per-type Get<X>Versions tool returns the same version count as generic.
 *   6. Logs U1–U7 facts without asserting (count, first/last versionId, sanitized URI shape, transport boolean).
 *
 * Config-driven: reads from get_object_versions_readonly in tests/test-config.yaml.
 * Skips cleanly when no SAP connection / test case disabled / empty object_name / wrong system type.
 *
 * Run: npx jest --testPathIgnorePatterns=__tests__/admin/ --testPathPatterns=readOnly/version/ObjectVersionHandlers --runInBand --forceExit
 */

import type { AbapConnection } from '@mcp-abap-adt/connection';
import {
  buildObjectVersionTools,
  VERSIONED_TYPES,
} from '../../../../handlers/common/high/objectVersionTools';
import { handleGetObjectVersionDiff } from '../../../../handlers/common/readonly/handleGetObjectVersionDiff';
import { handleGetObjectVersionSource } from '../../../../handlers/common/readonly/handleGetObjectVersionSource';
import { handleGetObjectVersions } from '../../../../handlers/common/readonly/handleGetObjectVersions';
import {
  assertNotHtmlSource,
  assertVersionContentUri,
} from '../../../../handlers/common/readonly/resolveVersionedObject';
import {
  getSystemType,
  getTimeout,
  isTestAvailableForSystem,
  loadTestConfig,
} from '../../helpers/configHelpers';
import { createTestLogger } from '../../helpers/loggerHelpers';
import {
  createTestConnectionAndSession,
  type SessionInfo,
} from '../../helpers/sessionHelpers';
import {
  callTool,
  createHardModeClient,
  isHardModeEnabled,
} from '../../helpers/testers/hardMode';
import {
  createHandlerContext,
  parseHandlerResponse,
} from '../../helpers/testHelpers';

const testLogger = createTestLogger('object-versions-readonly');

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getObjectVersionTestCase(objectType: string) {
  const config = loadTestConfig();
  const section = config?.get_object_versions_readonly;
  const cases: any[] = section?.test_cases || [];
  return (
    cases.find(
      (tc: any) =>
        tc?.name === objectType || tc?.params?.object_type === objectType,
    ) || null
  );
}

describe('Object Version Handlers Integration', () => {
  let connection: AbapConnection | null = null;
  let session: SessionInfo | null = null;
  let hasConfig = false;
  let mcp: {
    client: any;
    toolNames: Set<string>;
    close: () => Promise<void>;
  } | null = null;

  beforeAll(async () => {
    try {
      if (isHardModeEnabled()) {
        mcp = await createHardModeClient();
        hasConfig = true;
        return;
      }
      const result = await createTestConnectionAndSession();
      connection = result.connection;
      session = result.session;
      hasConfig = true;
    } catch (_error) {
      testLogger?.warn(
        '⚠️ Skipping tests: No .env file or SAP configuration found',
      );
      hasConfig = false;
    }
  });

  afterAll(async () => {
    if (mcp) {
      await mcp.close();
      mcp = null;
    }
  });

  const invoke = async (
    toolName: string,
    args: Record<string, unknown>,
    directCall: () => Promise<any>,
  ) => {
    if (!isHardModeEnabled()) {
      return directCall();
    }
    if (!mcp) {
      throw new Error('Hard mode MCP client is not initialized');
    }
    try {
      return await callTool(mcp.client, mcp.toolNames, [toolName], args);
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: error?.message || String(error) }],
      };
    }
  };

  const skipReason = (): string | null => {
    if (!hasConfig || (!isHardModeEnabled() && (!connection || !session))) {
      return 'No configuration, connection or session';
    }
    return null;
  };

  function findHighLevelTool(name: string) {
    const entry = buildObjectVersionTools().find(
      (e) => e.toolDefinition.name === name,
    );
    if (!entry) throw new Error(`High-level tool ${name} not found`);
    return entry;
  }

  // Additional case 1: invalid content_uri rejected upfront without SAP call (§3.1, §5.2)
  it('rejects invalid content_uri (@attacker.example/x) upfront without SAP call', async () => {
    const ctx = createHandlerContext({
      connection: connection || ({} as any),
      logger: testLogger,
    });

    const response = await invoke(
      'GetObjectVersionSource',
      { object_type: 'class', content_uri: '@attacker.example/x' },
      () =>
        handleGetObjectVersionSource(ctx, {
          object_type: 'class',
          content_uri: '@attacker.example/x',
        }),
    );

    expect(response.isError).toBe(true);
    const errorText = response.content?.[0]?.text || '';
    expect(errorText).toContain(
      "content_uri must be a relative ADT path starting with /sap/bc/adt/, as returned in a version entry's contentUri (got: @attacker.example/x).",
    );
  });

  // Additional case 2: missing_object_name returns standardized 404/406 (§3.2, §5.2, U6)
  it(
    'returns standardized 404/406 error message for missing_object_name as class (U6)',
    async () => {
      const reason = skipReason();
      if (reason) {
        testLogger?.info(`⏭️  Skipping test: ${reason}`);
        return;
      }

      const config = loadTestConfig();
      const section = config?.get_object_versions_readonly;
      const missingName =
        section?.missing_object_name || 'ZZ_T002_NO_SUCH_OBJECT';
      if (!missingName) {
        testLogger?.info(
          '⏭️  Skipping missing_object_name test: not configured',
        );
        return;
      }

      const ctx = createHandlerContext({
        connection: connection!,
        logger: testLogger,
      });

      const response = await invoke(
        'GetObjectVersions',
        { object_type: 'class', object_name: missingName },
        () =>
          handleGetObjectVersions(ctx, {
            object_type: 'class',
            object_name: missingName,
          }),
      );

      expect(response.isError).toBe(true);
      const errorMsg = response.content?.[0]?.text || '';
      if (!errorMsg.includes('does not exist, or')) {
        throw new Error(
          `Expected standardized message containing "does not exist, or" for missing object, got: ${errorMsg}`,
        );
      }
      testLogger?.info(
        `[U6] Missing object rejected with standardized message as expected: ${errorMsg}`,
      );
    },
    getTimeout('medium'),
  );

  // Roundtrip workflow across all 9 versioned object types (§5.2)
  describe.each(
    VERSIONED_TYPES,
  )('Version history for $object_type ($display)', (typeRow) => {
    it(
      `should execute version workflow for ${typeRow.object_type}`,
      async () => {
        const reason = skipReason();
        if (reason) {
          testLogger?.info(`⏭️  Skipping test: ${reason}`);
          return;
        }

        const testCase = getObjectVersionTestCase(typeRow.object_type);
        if (!testCase) {
          testLogger?.info(
            `⏭️  Skipping test: No test case configuration for ${typeRow.object_type}`,
          );
          return;
        }
        if (testCase.enabled !== true) {
          testLogger?.info(
            `⏭️  Test case for ${typeRow.object_type} is disabled`,
          );
          return;
        }
        if (
          !isTestAvailableForSystem(
            testCase.available_in || typeRow.available_in,
          )
        ) {
          testLogger?.info(
            `⏭️  Skipping test: ${typeRow.object_type} not available on ${getSystemType()}`,
          );
          return;
        }

        const objectName = String(testCase.params?.object_name || '').trim();
        if (!objectName) {
          testLogger?.info(
            `⏭️  Skipping ${typeRow.object_type}: object_name is empty (fill in test-config.yaml to run)`,
          );
          return;
        }

        testLogger?.info(
          `📋 Testing version workflow for ${typeRow.object_type} ${objectName}...`,
        );

        const ctx = createHandlerContext({
          connection: connection!,
          logger: testLogger,
        });

        // 1. Generic GetObjectVersions
        const genericArgs = {
          object_type: typeRow.object_type,
          object_name: objectName,
          ...(typeRow.object_type === 'function_module' &&
          testCase.params?.function_group_name
            ? { function_group_name: testCase.params.function_group_name }
            : {}),
        };

        const versionsResponse = await invoke(
          'GetObjectVersions',
          genericArgs,
          () => handleGetObjectVersions(ctx, genericArgs),
        );

        // Handle standardized 404/406 or fail
        if (versionsResponse.isError) {
          const errorMsg =
            versionsResponse.content?.[0]?.text || 'Unknown error';
          if (
            errorMsg.includes(
              'this system offers no version resource for this object type (SAP answered 404/406)',
            )
          ) {
            testLogger?.info(
              `[U2] NO_VERSION_RESOURCE for ${typeRow.object_type} ${objectName}: ${errorMsg}`,
            );
            return;
          }
          throw new Error(
            `GetObjectVersions failed for ${typeRow.object_type} ${objectName}: ${errorMsg}`,
          );
        }

        const versionsData = parseHandlerResponse(versionsResponse);
        expect(versionsData.success).toBe(true);
        expect(Array.isArray(versionsData.versions)).toBe(true);

        const minVersions =
          typeof testCase.params?.min_versions === 'number'
            ? testCase.params.min_versions
            : 1;
        expect(versionsData.versions.length).toBeGreaterThanOrEqual(
          minVersions,
        );

        const versions: any[] = versionsData.versions;
        testLogger?.info(
          `Found ${versions.length} version(s) for ${typeRow.object_type} ${objectName}`,
        );

        // 2. Every entry: versionId non-empty string, contentUri passes assertVersionContentUri (U1)
        for (const ver of versions) {
          expect(typeof ver.versionId).toBe('string');
          expect(ver.versionId.length).toBeGreaterThan(0);
          expect(() =>
            assertVersionContentUri(ver.contentUri, 'content_uri'),
          ).not.toThrow();
        }

        const firstUri = versions[0].contentUri;

        // 3. GetObjectVersionSource with versions[0].contentUri
        testLogger?.info(
          `📖 Fetching source for ${typeRow.object_type} version 0 from ${firstUri}...`,
        );
        const sourceResponse = await invoke(
          'GetObjectVersionSource',
          { object_type: typeRow.object_type, content_uri: firstUri },
          () =>
            handleGetObjectVersionSource(ctx, {
              object_type: typeRow.object_type,
              content_uri: firstUri,
            }),
        );

        expect(sourceResponse.isError).toBe(false);
        const sourceData = parseHandlerResponse(sourceResponse);
        expect(sourceData.success).toBe(true);
        expect(typeof sourceData.source).toBe('string');
        expect(sourceData.source.length).toBeGreaterThan(0);
        expect(() =>
          assertNotHtmlSource(sourceData.source, 'content_uri', firstUri),
        ).not.toThrow();

        // 4. GetObjectVersionDiff from last entry to first (when versions.length >= 2)
        if (versions.length >= 2) {
          const lastUri = versions[versions.length - 1].contentUri;
          testLogger?.info(
            `🔍 Computing diff from last version (${lastUri}) to first (${firstUri})...`,
          );

          const diffResponse = await invoke(
            'GetObjectVersionDiff',
            {
              object_type: typeRow.object_type,
              content_uri_from: lastUri,
              content_uri_to: firstUri,
            },
            () =>
              handleGetObjectVersionDiff(ctx, {
                object_type: typeRow.object_type,
                content_uri_from: lastUri,
                content_uri_to: firstUri,
              }),
          );

          expect(diffResponse.isError).toBe(false);
          const diffData = parseHandlerResponse(diffResponse);
          expect(diffData.success).toBe(true);
          expect(typeof diffData.identical).toBe('boolean');
          expect(typeof diffData.diff).toBe('string');
        }

        // 5. Per-type tool call Get<X>Versions returns same count as step 1
        const perTypeToolName = `Get${typeRow.display}Versions`;
        testLogger?.info(`📋 Testing high-level ${perTypeToolName}...`);
        const perTypeTool = findHighLevelTool(perTypeToolName);

        const perTypeArgs: Record<string, unknown> = {
          [typeRow.nameParam]: objectName,
        };
        if (
          typeRow.object_type === 'function_module' &&
          testCase.params?.function_group_name
        ) {
          perTypeArgs.function_group_name = testCase.params.function_group_name;
        }

        const hlVersionsResponse = await invoke(
          perTypeToolName,
          perTypeArgs,
          () => perTypeTool.handler(ctx, perTypeArgs),
        );

        expect(hlVersionsResponse.isError).toBe(false);
        const hlVersionsData = parseHandlerResponse(hlVersionsResponse);
        expect(hlVersionsData.success).toBe(true);
        expect(Array.isArray(hlVersionsData.versions)).toBe(true);
        expect(hlVersionsData.versions.length).toBe(versions.length);

        // 6. Log U1–U7 facts without asserting
        const firstVersionId = versions[0].versionId;
        const lastVersionId = versions[versions.length - 1].versionId;
        const contentUriShape = firstUri.replace(
          new RegExp(escapeRegExp(objectName), 'gi'),
          '<NAME>',
        );
        const transportPresent = versions.map((v: any) =>
          Boolean(v.transportRequest),
        );

        testLogger?.info(
          `[U1-U7 FACTS] ${typeRow.object_type} ${objectName}: count=${versions.length}, firstVersionId=${firstVersionId}, lastVersionId=${lastVersionId}, contentUriShape=${contentUriShape}, transportPresent=${JSON.stringify(transportPresent)}`,
        );

        testLogger?.info(
          `✅ Version workflow for ${typeRow.object_type} completed successfully.`,
        );
      },
      getTimeout('medium'),
    );
  });
});
