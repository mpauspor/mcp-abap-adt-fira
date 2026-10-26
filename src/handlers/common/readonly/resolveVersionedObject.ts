/**
 * Shared object_type → IAdtObject resolver for the read-only version-history
 * handlers (GetObjectVersions / GetObjectVersionSource).
 *
 * Uses the SAME client.getX() accessors and config name keys as handleLockObject,
 * but only for the object types that actually support version history
 * (IAdtSourceObject). Callers use the returned handler to call
 * .getVersions(config) / .getVersionSource(contentUri). Non-versioned lockable
 * types (function_group, domain, data_element, package) are deliberately absent.
 */

import type { AdtClient } from '@mcp-abap-adt/adt-clients';
import type { IAdtObject } from '@mcp-abap-adt/interfaces';

/** object_type values supported for version history (same set as LockObject). */
// Only object types whose adt-clients handler actually implements version
// history (IAdtSourceObject) belong here. function_group, domain, data_element
// and package are IAdtNonVersionedObject — their getVersions/getVersionSource
// throw "not supported", so exposing them here advertised a capability that
// never worked. The lock switch (handleLockObject) is intentionally wider:
// those types ARE lockable, just not versioned.
export const VERSIONED_OBJECT_TYPES = [
  'class',
  'program',
  'interface',
  'function_module',
  'table',
  'structure',
  'ddl',
  'behavior_definition',
  'metadata_extension',
] as const;

export interface ResolvedVersionedObject {
  /** The IAdtObject instance to call getVersions/getVersionSource on. */
  obj: IAdtObject<any, any>;
  /** Identity config to pass to getVersions(config). */
  config: Record<string, unknown>;
}

/**
 * Resolve an object_type + name into an IAdtObject instance and its identity
 * config. Returns null for an unknown object_type (caller emits the error).
 *
 * @throws Error for a malformed function_module identity (missing group name).
 */
export function resolveVersionedObject(
  client: AdtClient,
  objectType: string,
  objectName: string,
  functionGroupName?: string,
): ResolvedVersionedObject | null {
  const name = objectName.toUpperCase();
  switch (objectType) {
    case 'class':
      return { obj: client.getClass(), config: { className: name } };
    case 'program':
      return { obj: client.getProgram(), config: { programName: name } };
    case 'interface':
      return { obj: client.getInterface(), config: { interfaceName: name } };
    case 'function_module': {
      // Identity is the FM name + its owning function group. The group can be
      // passed explicitly (function_group_name) or via GROUP|FM_NAME, as the
      // lock handler accepts.
      let groupName = functionGroupName?.toUpperCase();
      let fmName = name;
      if (name.includes('|')) {
        const [g, fm] = name.split('|');
        groupName = (functionGroupName?.toUpperCase() || g).toUpperCase();
        fmName = fm;
      }
      if (!groupName) {
        throw new Error(
          'function_group_name is required for function_module (or use GROUP|FM_NAME).',
        );
      }
      return {
        obj: client.getFunctionModule(),
        config: { functionGroupName: groupName, functionModuleName: fmName },
      };
    }
    case 'table':
      return { obj: client.getTable(), config: { tableName: name } };
    case 'structure':
      return { obj: client.getStructure(), config: { structureName: name } };
    case 'ddl':
      return { obj: client.getDdl(), config: { ddlName: name } };
    case 'behavior_definition':
      return { obj: client.getBehaviorDefinition(), config: { name } };
    case 'metadata_extension':
      return { obj: client.getMetadataExtension(), config: { name } };
    default:
      return null;
  }
}

function sanitizeUriForError(val: unknown): string {
  return (
    String(val)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: sanitize control characters from error output
      .replace(/[\x00-\x1f]/g, '')
      .slice(0, 80)
  );
}

/**
 * Validates that an untrusted version content URI is a safe relative ADT path.
 *
 * Implements the contract of decision D-011 and object-version spec §3.1
 * - Must be a string
 * - Length 1..2048
 * - No control characters (< U+0021 including space), DEL (U+007F), backslash (\), or hash (#)
 * - Must start with `/sap/bc/adt/`
 * - No `//` anywhere in the path
 * - No `.` or `..` path segments (before or after URI decoding)
 * - Valid percent-encoding in path
 *
 * @param uri The untrusted URI value from tool arguments
 * @param field The field name being validated ('content_uri', 'content_uri_from', 'content_uri_to')
 * @returns The validated URI string unchanged
 * @throws Error if validation fails, with message:
 *   `${field} must be a relative ADT path starting with /sap/bc/adt/, as returned in a version entry's contentUri (got: ${sanitized}).`
 */
export function assertVersionContentUri(uri: unknown, field: string): string {
  const err = () =>
    new Error(
      `${field} must be a relative ADT path starting with /sap/bc/adt/, as returned in a version entry's contentUri (got: ${sanitizeUriForError(
        uri,
      )}).`,
    );

  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2048) {
    throw err();
  }

  // Check forbidden characters: control characters (< U+0021 including space U+0020),
  // DEL (U+007F), backslash (\), and hash (#).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: validate URI characters against control and delimiter characters
  if (/[\u0000-\u0020\u007f\\#]/.test(uri)) {
    throw err();
  }

  if (!uri.startsWith('/sap/bc/adt/')) {
    throw err();
  }

  const queryIndex = uri.indexOf('?');
  const pathPart = queryIndex === -1 ? uri : uri.slice(0, queryIndex);

  if (pathPart.includes('//')) {
    throw err();
  }

  const segments = pathPart.split('/');
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw err();
    }
    if (decoded === '.' || decoded === '..') {
      throw err();
    }
  }

  return uri;
}

/**
 * Asserts that the source returned by getVersionSource is not an HTML page
 * (e.g. login redirect, error page, session expiration).
 *
 * Contract (object-version spec §3.4):
 * - Checks: /^\s*<(?:!doctype\s+html|html)[\s>]/i
 * - Does not throw for null/undefined or ABAP source that contains <html> later in text.
 */
export function assertNotHtmlSource(
  source: unknown,
  field: string,
  contentUri?: string,
): void {
  const text = typeof source === 'string' ? source : String(source ?? '');
  if (/^\s*<(?:!doctype\s+html|html)[\s>]/i.test(text)) {
    const uriLabel = contentUri || field;
    throw new Error(
      `SAP returned an HTML page instead of source for ${field} (${uriLabel}). The session may have expired, or the URI is not a version resource.`,
    );
  }
}
