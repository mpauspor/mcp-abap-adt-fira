/**
 * Low-level ADT operations for standalone ABAP includes (PROG/I).
 *
 * Includes live under `/sap/bc/adt/programs/includes/`, a different resource
 * from programs. `@mcp-abap-adt/adt-clients` implements only the READ half of
 * that resource (`core/shared/include.js`), and every write path in the client
 * hardcodes `/sap/bc/adt/programs/programs/`. There is therefore no way to
 * write an include through the client at all — which is why `UpdateProgram`
 * appeared to work on includes while writing nothing.
 *
 * This module supplies the missing half against the same endpoints ADT itself
 * uses, following the identical lock → PUT source → unlock shape the client
 * uses for programs.
 */

import type { IAbapConnection, ILogger } from '@mcp-abap-adt/interfaces';
import { XMLParser } from 'fast-xml-parser';
import { encodeSapObjectName, makeAdtRequestWithTimeout } from '../utils';

const CT_SOURCE = 'text/plain; charset=utf-8';
const ACCEPT_SOURCE = 'text/plain';
const ACCEPT_LOCK =
  'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.lock.Result';

/** ADT paths are lowercase; the name still needs URI-encoding for namespaced objects (/FOO/BAR). */
function includePath(includeName: string): string {
  return `/sap/bc/adt/programs/includes/${encodeSapObjectName(
    includeName,
  ).toLowerCase()}`;
}

/**
 * Read an include's source.
 */
export async function readIncludeSource(
  connection: IAbapConnection,
  includeName: string,
): Promise<string> {
  const response = await makeAdtRequestWithTimeout(
    connection,
    `${includePath(includeName)}/source/main`,
    'GET',
    'default',
    undefined,
    undefined,
    { Accept: ACCEPT_SOURCE },
  );
  return typeof response.data === 'string'
    ? response.data
    : String(response.data);
}

/**
 * Lock an include for modification, returning the lock handle.
 */
export async function lockInclude(
  connection: IAbapConnection,
  includeName: string,
): Promise<string> {
  const response = await makeAdtRequestWithTimeout(
    connection,
    `${includePath(includeName)}?_action=LOCK&accessMode=MODIFY`,
    'POST',
    'default',
    null,
    undefined,
    { Accept: ACCEPT_LOCK },
  );

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
  });
  const parsed = parser.parse(response.data);
  const lockHandle = parsed?.['asx:abap']?.['asx:values']?.DATA?.LOCK_HANDLE;

  if (!lockHandle) {
    throw new Error(
      `Failed to obtain a lock handle for include ${includeName}. It may be locked by another user.`,
    );
  }
  return String(lockHandle);
}

/**
 * Unlock a previously locked include.
 */
export async function unlockInclude(
  connection: IAbapConnection,
  includeName: string,
  lockHandle: string,
): Promise<void> {
  await makeAdtRequestWithTimeout(
    connection,
    `${includePath(includeName)}?_action=UNLOCK&lockHandle=${encodeURIComponent(
      lockHandle,
    )}`,
    'POST',
    'default',
    null,
  );
}

/**
 * Upload include source. Assumes the include is already locked.
 */
export async function uploadIncludeSource(
  connection: IAbapConnection,
  includeName: string,
  sourceCode: string,
  lockHandle: string,
  transportRequest?: string,
): Promise<void> {
  let url = `${includePath(
    includeName,
  )}/source/main?lockHandle=${encodeURIComponent(lockHandle)}`;
  if (transportRequest) {
    url += `&corrNr=${encodeURIComponent(transportRequest)}`;
  }

  await makeAdtRequestWithTimeout(
    connection,
    url,
    'PUT',
    'default',
    sourceCode,
    undefined,
    { 'Content-Type': CT_SOURCE, Accept: ACCEPT_SOURCE },
  );
}

/**
 * Create the include object itself (metadata only — no source).
 */
export async function createIncludeObject(
  connection: IAbapConnection,
  args: {
    includeName: string;
    packageName: string;
    description: string;
    transportRequest?: string;
    masterLanguage?: string;
    responsible?: string;
  },
  logger?: ILogger,
): Promise<void> {
  // ADT caps object descriptions at 60 characters and rejects longer ones.
  const description = (args.description || args.includeName).slice(0, 60);
  const lang = args.masterLanguage || 'EN';
  const responsibleAttr = args.responsible
    ? ` adtcore:responsible="${args.responsible}"`
    : '';

  const url = `/sap/bc/adt/programs/includes${
    args.transportRequest
      ? `?corrNr=${encodeURIComponent(args.transportRequest)}`
      : ''
  }`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?><include:abapInclude xmlns:include="http://www.sap.com/adt/programs/includes" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:description="${description}" adtcore:language="${lang}" adtcore:name="${args.includeName}" adtcore:type="PROG/I" adtcore:masterLanguage="${lang}"${responsibleAttr}>
  <adtcore:packageRef adtcore:name="${args.packageName}"/>
</include:abapInclude>`;

  logger?.debug(`Creating include object: ${args.includeName}`);

  await makeAdtRequestWithTimeout(
    connection,
    url,
    'POST',
    'default',
    xml,
    undefined,
    {
      'Content-Type':
        'application/vnd.sap.adt.programs.includes.v2+xml; charset=utf-8',
      Accept: 'application/vnd.sap.adt.programs.includes.v2+xml',
    },
  );
}

/**
 * Determine whether a repository object is an include.
 *
 * Used to stop `UpdateProgram` from silently writing an include through the
 * program endpoint. Probing the include resource is the cheapest reliable
 * signal: a 200 means the name resolves as an include, anything else means it
 * does not, and a probe failure must not block the caller's actual request.
 */
export async function isInclude(
  connection: IAbapConnection,
  objectName: string,
): Promise<boolean> {
  try {
    const response = await makeAdtRequestWithTimeout(
      connection,
      `${includePath(objectName)}/source/main`,
      'GET',
      'default',
      undefined,
      undefined,
      { Accept: ACCEPT_SOURCE },
    );
    return response.status === 200;
  } catch {
    return false;
  }
}
