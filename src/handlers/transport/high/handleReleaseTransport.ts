/**
 * ReleaseTransport - release a transport request (or task) via ADT.
 *
 * New code: `AdtRequest` in @mcp-abap-adt/adt-clients deliberately stubs
 * update/delete/activate/check for transports (they throw "not supported"),
 * and offers no release at all, so releasing meant leaving the tool and going
 * to SE01.
 *
 * Release is a JOB. SAP accepts the request and runs it, so a 200 means
 * "accepted", not "released" — the status is read back here to tell the two
 * apart.
 */

import { XMLParser } from 'fast-xml-parser';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import {
  makeAdtRequestWithTimeout,
  return_error,
  return_response,
} from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'ReleaseTransport',
  available_in: ['onprem'] as const,
  description:
    'Release an ABAP transport request or task. Releasing is irreversible — a released request cannot be reopened, only followed by a new one. Tasks must be released before their parent request. The response reports the status read back from SAP after the release job, not merely that the call was accepted.',
  inputSchema: {
    type: 'object',
    properties: {
      transport_request: {
        type: 'string',
        description:
          'Transport request or task number (e.g., DS4K901132). Tasks are released individually before the parent request.',
      },
      ignore_locks: {
        type: 'boolean',
        description:
          'Release even when objects in the request are still locked elsewhere. Default false.',
      },
    },
    required: ['transport_request'],
  },
} as const;

/** E070-TRSTATUS codes that mean the request is no longer modifiable. */
const RELEASED_STATUSES = new Set(['R', 'N', 'O']);

const STATUS_TEXT: Record<string, string> = {
  D: 'modifiable',
  L: 'modifiable, protected',
  O: 'release started',
  R: 'released',
  N: 'released (with import protection)',
};

async function readTransportStatus(
  context: HandlerContext,
  transportNumber: string,
): Promise<{ status?: string; raw?: string }> {
  try {
    const response = await makeAdtRequestWithTimeout(
      context.connection,
      `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(transportNumber)}`,
      'GET',
      'default',
      undefined,
      undefined,
      { Accept: 'application/vnd.sap.adt.transportorganizer.v1+xml' },
    );

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      parseAttributeValue: false,
    });
    const parsed = parser.parse(response.data);
    const root = parsed['tm:root'] || parsed.root || {};
    const request = root['tm:request'] || {};
    return {
      status: request['tm:status'],
      raw: typeof response.data === 'string' ? response.data : undefined,
    };
  } catch {
    return {};
  }
}

export async function handleReleaseTransport(
  context: HandlerContext,
  args: { transport_request?: string; ignore_locks?: boolean },
) {
  const { connection, logger } = context;
  try {
    if (!args?.transport_request) {
      return return_error('transport_request is required');
    }

    const transportNumber = args.transport_request.trim().toUpperCase();

    const before = await readTransportStatus(context, transportNumber);
    if (before.status && RELEASED_STATUSES.has(before.status)) {
      return return_error(
        new Error(
          `Transport ${transportNumber} is already released (status ${before.status} — ${STATUS_TEXT[before.status] ?? 'released'}).`,
        ),
      );
    }

    logger?.info(`Releasing transport ${transportNumber}`);

    const url =
      `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(transportNumber)}/newreleasejobs` +
      (args.ignore_locks ? '?ignoreLocks=true' : '');

    let response: any;
    try {
      response = await makeAdtRequestWithTimeout(
        connection,
        url,
        'POST',
        'long',
        null,
        undefined,
        {
          Accept: 'application/vnd.sap.adt.transportorganizer.v1+xml',
          'Content-Type': 'application/vnd.sap.adt.transportorganizer.v1+xml',
        },
      );
    } catch (releaseError: any) {
      const body = releaseError?.response?.data;
      let detail =
        typeof body === 'string' && body
          ? body
          : releaseError?.message || String(releaseError);

      // SAP explains a refused release precisely — objects locked in another
      // request, tasks still open, no authorisation. Surface that instead of
      // the HTTP status.
      const match =
        typeof detail === 'string'
          ? detail.match(/<message[^>]*>([^<]+)</)
          : null;
      if (match) detail = match[1];

      logger?.error(`Release of ${transportNumber} failed: ${detail}`);
      return return_error(
        `Failed to release transport ${transportNumber}: ${detail}`,
      );
    }

    // The HTTP status says nothing: SAP answers 200 even for a transport that
    // does not exist. The authoritative signal is tm:releasetimestamp on the
    // response — zero means nothing was released. (Probed on DS4: a bogus
    // number returns 200 with tm:releasetimestamp="0 ", a real release returns
    // 200 with a timestamp.)
    const releaseParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      parseAttributeValue: false,
    });
    const releaseRoot =
      releaseParser.parse(response.data)?.['tm:root'] ??
      releaseParser.parse(response.data)?.root ??
      {};
    const releaseTimestamp = String(
      releaseRoot['tm:releasetimestamp'] ?? '0',
    ).trim();
    const timestampIndicatesRelease =
      releaseTimestamp !== '' && releaseTimestamp !== '0';

    // Corroborate with the request's own status.
    const after = await readTransportStatus(context, transportNumber);
    const released =
      timestampIndicatesRelease &&
      (!after.status || RELEASED_STATUSES.has(after.status));

    logger?.info(
      `Release of ${transportNumber}: status ${after.status ?? 'unknown'}`,
    );

    return return_response({
      data: JSON.stringify(
        {
          success: released,
          transport_request: transportNumber,
          status: after.status,
          status_text: after.status
            ? (STATUS_TEXT[after.status] ?? after.status)
            : undefined,
          previous_status: before.status,
          release_timestamp: timestampIndicatesRelease
            ? releaseTimestamp
            : undefined,
          message: released
            ? `Transport ${transportNumber} released (${releaseTimestamp}), target ${after.status ? '' : 'unknown'}.`.trim()
            : timestampIndicatesRelease
              ? `SAP reported a release timestamp for ${transportNumber} but its status is ${after.status ?? 'unreadable'}. Check SE01.`
              : `Nothing was released. SAP returned no release timestamp for ${transportNumber} — the request may not exist, may belong to another user, or may not be releasable (open tasks, locked objects).`,
        },
        null,
        2,
      ),
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    });
  } catch (error: any) {
    logger?.error(`ReleaseTransport failed: ${error?.message || error}`);
    return return_error(error);
  }
}
