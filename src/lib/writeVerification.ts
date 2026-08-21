/**
 * Post-write verification wired across every source-carrying Update* tool.
 *
 * `UpdateProgram` and `UpdateInclude` verify inline, because their guards are
 * bound up with routing an include away from the program resource. Every other
 * Update* handler still asserted success from the absence of an exception, so
 * they are verified here instead — one table and one wrapper, applied at
 * registration, rather than the same twenty edits repeated by hand.
 *
 * Reading `/source/main` WITHOUT a version parameter returns the working
 * (inactive) version when one exists, and the active version otherwise.
 * Verified on a 7.5x system: with an active ACTIVE_ONE and a pending PENDING_TWO, the
 * unqualified URL answers PENDING_TWO. That is what makes one comparison
 * correct for both `activate: true` and `activate: false` — qualifying the
 * version would make every non-activating update look like a failed write.
 */

import type { IAbapConnection, ILogger } from '@mcp-abap-adt/interfaces';
import { encodeSapObjectName, makeAdtRequestWithTimeout } from './utils';
import { verifySourceWritten } from './verifyWrite';

interface SourceWriteDescriptor {
  /** Handler argument holding the source text. */
  sourceArg: string;
  /**
   * Set when the handler already reads the object back itself. Such tools are
   * still listed here so `source_path` knows where their source argument is,
   * but they are skipped by the verification wrapper to avoid a second read.
   */
  verifiesInline?: boolean;
  /** Builds the ADT source URL from the handler's arguments. */
  sourceUrl: (args: any) => string | undefined;
  /** Human label for messages, e.g. `Class ZCL_FOO`. */
  label: (args: any) => string;
}

const enc = (value: unknown): string =>
  encodeSapObjectName(String(value ?? '')).toLowerCase();

/** `/source/main` under a fixed ADT collection. */
function sourceUnder(collection: string, nameArg: string) {
  return (args: any) =>
    args?.[nameArg]
      ? `/sap/bc/adt/${collection}/${enc(args[nameArg])}/source/main`
      : undefined;
}

/** Class-local sections are addressed directly, with no `/source/main` suffix. */
function classInclude(section: string) {
  return (args: any) =>
    args?.class_name
      ? `/sap/bc/adt/oo/classes/${enc(args.class_name)}/includes/${section}`
      : undefined;
}

const named = (prefix: string, nameArg: string) => (args: any) =>
  `${prefix} ${String(args?.[nameArg] ?? '').toUpperCase()}`;

/**
 * Tools whose write can be confirmed by reading a source document back.
 *
 * Deliberately excluded: DDIC objects edited through structured metadata rather
 * than source (UpdateDomain, UpdateDataElement, UpdateMessageClass,
 * UpdateServiceBinding, UpdateFunctionGroup). Their payload is generated XML,
 * so a byte comparison against the caller's arguments would report a mismatch
 * on every successful write. They need a different check and do not have one
 * yet — they are unverified, not verified-and-passing.
 */
export const SOURCE_WRITE_TOOLS: Record<string, SourceWriteDescriptor> = {
  // Verify inline (they guard include-vs-program routing), listed here so a
  // large source can still be supplied from a file.
  UpdateProgram: {
    sourceArg: 'source_code',
    verifiesInline: true,
    sourceUrl: sourceUnder('programs/programs', 'program_name'),
    label: named('Program', 'program_name'),
  },
  UpdateInclude: {
    sourceArg: 'source_code',
    verifiesInline: true,
    sourceUrl: sourceUnder('programs/includes', 'include_name'),
    label: named('Include', 'include_name'),
  },
  UpdateClass: {
    sourceArg: 'source_code',
    sourceUrl: sourceUnder('oo/classes', 'class_name'),
    label: named('Class', 'class_name'),
  },
  UpdateInterface: {
    sourceArg: 'source_code',
    sourceUrl: sourceUnder('oo/interfaces', 'interface_name'),
    label: named('Interface', 'interface_name'),
  },
  UpdateDdl: {
    sourceArg: 'ddl_source',
    sourceUrl: sourceUnder('ddic/ddl/sources', 'ddl_name'),
    label: named('CDS view', 'ddl_name'),
  },
  UpdateMetadataExtension: {
    sourceArg: 'source_code',
    sourceUrl: sourceUnder('ddic/ddlx/sources', 'name'),
    label: named('Metadata extension', 'name'),
  },
  UpdateBehaviorDefinition: {
    sourceArg: 'source_code',
    sourceUrl: sourceUnder('ddic/bdef/sources', 'name'),
    label: named('Behavior definition', 'name'),
  },
  UpdateServiceDefinition: {
    sourceArg: 'source_code',
    sourceUrl: sourceUnder('ddic/srvd/sources', 'service_definition_name'),
    label: named('Service definition', 'service_definition_name'),
  },
  UpdateTable: {
    sourceArg: 'ddl_code',
    sourceUrl: sourceUnder('ddic/tables', 'table_name'),
    label: named('Table', 'table_name'),
  },
  UpdateStructure: {
    sourceArg: 'ddl_code',
    sourceUrl: sourceUnder('ddic/structures', 'structure_name'),
    label: named('Structure', 'structure_name'),
  },
  UpdateFunctionModule: {
    sourceArg: 'source_code',
    sourceUrl: (args: any) =>
      args?.function_group_name && args?.function_module_name
        ? `/sap/bc/adt/functions/groups/${enc(
            args.function_group_name,
          )}/fmodules/${enc(args.function_module_name)}/source/main`
        : undefined,
    label: named('Function module', 'function_module_name'),
  },
  UpdateLocalDefinitions: {
    sourceArg: 'definitions_code',
    sourceUrl: classInclude('definitions'),
    label: named('Local definitions of', 'class_name'),
  },
  UpdateLocalMacros: {
    sourceArg: 'macros_code',
    sourceUrl: classInclude('macros'),
    label: named('Local macros of', 'class_name'),
  },
  UpdateLocalTestClass: {
    sourceArg: 'test_class_code',
    sourceUrl: classInclude('testclasses'),
    label: named('Test class of', 'class_name'),
  },
  UpdateLocalTypes: {
    sourceArg: 'local_types_code',
    // "Local types" is the CCIMP include, addressed as `implementations` —
    // NOT `types`, which SAP rejects with a 400 uriMappingError. Taken from
    // AdtLocalTypes in the client, then confirmed against a live system.
    sourceUrl: classInclude('implementations'),
    label: named('Local types of', 'class_name'),
  },
};

async function readAdtSource(
  connection: IAbapConnection,
  url: string,
): Promise<string> {
  const response = await makeAdtRequestWithTimeout(
    connection,
    url,
    'GET',
    'default',
    undefined,
    undefined,
    { Accept: 'text/plain' },
  );
  return typeof response.data === 'string'
    ? response.data
    : String(response.data);
}

/** Record the verification outcome on the tool's JSON payload, when it has one. */
function annotate(result: any, fields: Record<string, unknown>): any {
  const entry = result?.content?.[0];
  if (typeof entry?.text !== 'string') return result;

  try {
    const payload = JSON.parse(entry.text);
    if (payload === null || typeof payload !== 'object') return result;
    return {
      ...result,
      content: [
        { ...entry, text: JSON.stringify({ ...payload, ...fields }, null, 2) },
        ...result.content.slice(1),
      ],
    };
  } catch {
    // Plain-text result — nothing to annotate.
    return result;
  }
}

/**
 * Wrap a registered Update* handler so its success claim is checked.
 *
 * Failure policy is asymmetric on purpose:
 * - Read back OK and the content DIFFERS → hard error. That is positive
 *   evidence the write did not land where the caller was told it did.
 * - Read back FAILS → report `write_verified: false` with the reason, but let
 *   the original result stand. The write may well have succeeded, and turning
 *   a wrong URL in the table above into a failed update would be worse than
 *   the gap it closes.
 */
export function withWriteVerification<H extends (...args: any[]) => any>(
  toolName: string,
  handler: H,
  getContext: () => { connection: IAbapConnection; logger?: ILogger },
): (...args: Parameters<H>) => Promise<Awaited<ReturnType<H>>> {
  const descriptor = SOURCE_WRITE_TOOLS[toolName];
  if (!descriptor || descriptor.verifiesInline) {
    return handler as (
      ...args: Parameters<H>
    ) => Promise<Awaited<ReturnType<H>>>;
  }

  return async (...callArgs: Parameters<H>) => {
    const result = await handler(...callArgs);
    if (result?.isError) return result;

    // Registered handlers are already bound to their context, so the tool
    // arguments are the last parameter regardless of arity.
    const args: any = callArgs[callArgs.length - 1];
    const expected = args?.[descriptor.sourceArg];
    const url = descriptor.sourceUrl(args);
    if (typeof expected !== 'string' || !url) return result;

    const { connection, logger } = getContext();
    const label = descriptor.label(args);

    const verification = await verifySourceWritten(
      () => readAdtSource(connection, url),
      expected,
      label,
      logger,
    );

    if (verification.verified) {
      return annotate(result, { write_verified: true });
    }

    if (verification.actual_bytes !== undefined) {
      // The object was readable and does not hold what was sent.
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `${label} update could not be confirmed: ${verification.reason}`,
          },
        ],
      };
    }

    return annotate(result, {
      write_verified: false,
      write_verification_note: verification.reason,
    });
  };
}
