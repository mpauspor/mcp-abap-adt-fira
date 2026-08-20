/**
 * Group activation of ABAP repository objects.
 *
 * Mirrors the ADT flow used by `@mcp-abap-adt/adt-clients`
 * (POST /activation/runs → poll the run → GET the results), but builds object
 * URIs through this repository's own `buildObjectUri`, because the client's
 * version cannot address includes and drops the caller's explicit URI. See
 * `objectUri.ts` for the specifics.
 */

import type { IAbapConnection, ILogger } from '@mcp-abap-adt/interfaces';
import { XMLParser } from 'fast-xml-parser';
import { makeAdtRequestWithTimeout } from '../utils';
import { buildObjectUri, type ObjectUriRequest } from './objectUri';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
});

/** XML attribute values must be escaped; object descriptions and namespaced names can contain & and ". */
function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractRunId(location: unknown): string | null {
  const value = Array.isArray(location) ? location[0] : location;
  if (typeof value !== 'string') return null;
  const match = value.match(/\/activation\/runs\/([^/?]+)/);
  return match ? match[1] : null;
}

async function waitForActivationRun(
  connection: IAbapConnection,
  runId: string,
  logger?: ILogger,
  maxWaitTime = 60000,
  pollInterval = 1000,
): Promise<void> {
  const startTime = Date.now();
  const url = `/sap/bc/adt/activation/runs/${runId}?withLongPolling=true`;

  while (Date.now() - startTime < maxWaitTime) {
    const response = await makeAdtRequestWithTimeout(
      connection,
      url,
      'GET',
      'default',
      undefined,
      undefined,
      {
        Accept: 'application/xml, application/vnd.sap.adt.backgroundrun.v1+xml',
      },
    );

    const parsed = xmlParser.parse(response.data);
    const run = parsed?.['runs:run'] ?? parsed?.run;
    if (!run) {
      throw new Error('Invalid activation run response format');
    }

    const status = run['@_runs:status'] ?? run['@_status'] ?? run.status;
    if (status === 'finished') return;
    if (status === 'error' || status === 'failed') {
      throw new Error(`Activation run failed with status: ${status}`);
    }

    logger?.debug(`Activation run ${runId} status=${status}; polling`);
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Activation run timed out after ${maxWaitTime}ms`);
}

/**
 * Activate a set of objects in one run.
 *
 * @returns the raw activation results payload, for the caller to parse.
 */
export async function activateObjectsGroup(
  connection: IAbapConnection,
  objects: ObjectUriRequest[],
  preauditRequested = true,
  logger?: ILogger,
): Promise<string> {
  // Build every URI before issuing anything, so an unaddressable object fails
  // with a clear message instead of a 404 midway through an activation run.
  const references = objects.map((object) => {
    const uri = buildObjectUri(object);
    const typeAttr = object.type
      ? ` adtcore:type="${escapeXmlAttribute(object.type)}"`
      : '';
    return `  <adtcore:objectReference adtcore:uri="${escapeXmlAttribute(
      uri,
    )}"${typeAttr} adtcore:name="${escapeXmlAttribute(object.name)}"/>`;
  });

  const xmlBody = `<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
${references.join('\n')}
</adtcore:objectReferences>`;

  logger?.debug(`Activation request body:\n${xmlBody}`);

  const startResponse = await makeAdtRequestWithTimeout(
    connection,
    `/sap/bc/adt/activation/runs?method=activate&preauditRequested=${preauditRequested}`,
    'POST',
    'default',
    xmlBody,
    undefined,
    { Accept: 'application/xml', 'Content-Type': 'application/xml' },
  );

  const headers: any = startResponse.headers ?? {};
  const runId = extractRunId(
    headers.location ??
      headers.Location ??
      headers['content-location'] ??
      headers['Content-Location'],
  );

  if (!runId) {
    throw new Error(
      'Failed to extract the activation run ID from the response headers',
    );
  }

  await waitForActivationRun(connection, runId, logger);

  const results = await makeAdtRequestWithTimeout(
    connection,
    `/sap/bc/adt/activation/results/${runId}`,
    'GET',
    'default',
    undefined,
    undefined,
    { Accept: 'application/xml' },
  );

  return typeof results.data === 'string' ? results.data : String(results.data);
}
