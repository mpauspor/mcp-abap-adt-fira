/**
 * CreateTransport Handler - Create new ABAP transport request via ADT API
 *
 * Posts to /sap/bc/adt/cts/transportrequests directly rather than going
 * through `@mcp-abap-adt/adt-clients`, whose `createTransport` corrupts two of
 * the three fields that matter:
 *
 * - It wraps the target system in slashes — `tm:target="/QS4/"` — and SAP
 *   answers "Target '/QS4/' does not exist" even for a system that is defined
 *   in TMSCSYS. The target must be the bare name, matching what E070-TARSYSTEM
 *   stores (ITE, PRE, PRD, ...).
 * - It passes the owner through verbatim, so a lowercase user name reaches SAP
 *   as-is and is rejected with "User <name> does not exist". SAP user names are
 *   uppercase.
 *
 * Neither could be corrected from the caller's side, because the client
 * rewrites whatever it is given.
 *
 * Workflow: create
 */

import { XMLParser } from 'fast-xml-parser';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { getSystemContext } from '../../../lib/systemContext';
import {
  makeAdtRequestWithTimeout,
  return_error,
  return_response,
} from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'CreateTransport',
  available_in: ['onprem', 'cloud'] as const,
  description:
    'Create a new ABAP transport request in SAP system for development objects. If target_system is omitted the request is created as LOCAL; the response always reports the target SAP actually assigned, and warns when it differs from the one requested.',
  inputSchema: {
    type: 'object',
    properties: {
      transport_type: {
        type: 'string',
        description:
          "Transport type: 'workbench' (cross-client) or 'customizing' (client-specific)",
        enum: ['workbench', 'customizing'],
        default: 'workbench',
      },
      description: {
        type: 'string',
        description: 'Transport request description (mandatory)',
      },
      target_system: {
        type: 'string',
        description:
          "Target system as its bare name, e.g. 'QS4', 'PRD', 'ITE' — no slashes, no client suffix. Must be a transport target defined in STMS (see TMSCSYS). If omitted or empty, the request is created as LOCAL.",
      },
      owner: {
        type: 'string',
        description:
          'Transport owner (optional, defaults to the current user). Uppercased automatically.',
      },
    },
    required: ['description'],
  },
} as const;

interface CreateTransportArgs {
  transport_type?: string;
  description: string;
  target_system?: string;
  owner?: string;
}

/** XML attribute values must be escaped; descriptions routinely contain & and quotes. */
function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function handleCreateTransport(
  context: HandlerContext,
  args: CreateTransportArgs,
) {
  const { connection, logger } = context;
  try {
    if (!args?.description) {
      return return_error('Transport description is required');
    }

    // SAP user names are uppercase; a lowercase owner is rejected outright.
    const owner = (
      args.owner?.trim() ||
      getSystemContext().responsible ||
      ''
    ).toUpperCase();

    if (!owner) {
      return return_error(
        'Transport owner is required and could not be determined. Pass "owner", or set SAP_RESPONSIBLE / SAP_USERNAME.',
      );
    }

    // The bare system name — NOT wrapped in slashes. An empty target means the
    // request stays local to this system.
    const requestedTarget = args.target_system?.trim().toUpperCase() || '';
    const target = requestedTarget || 'LOCAL';
    const transportType = args.transport_type === 'customizing' ? 'T' : 'K';

    // ADT caps the description at 60 characters.
    const description = args.description.slice(0, 60);

    logger?.info(
      `Creating transport: target=${target} owner=${owner} type=${transportType}`,
    );

    const xmlBody = `<?xml version="1.0" encoding="ASCII"?>
<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:useraction="newrequest">
  <tm:request tm:desc="${escapeXmlAttribute(description)}" tm:type="${transportType}" tm:target="${escapeXmlAttribute(target)}" tm:cts_project="">
    <tm:task tm:owner="${escapeXmlAttribute(owner)}"/>
  </tm:request>
</tm:root>`;

    let response: any;
    try {
      response = await makeAdtRequestWithTimeout(
        connection,
        '/sap/bc/adt/cts/transportrequests',
        'POST',
        'default',
        xmlBody,
        undefined,
        {
          Accept: 'application/vnd.sap.adt.transportorganizer.v1+xml',
          'Content-Type': 'text/plain',
        },
      );
    } catch (requestError: any) {
      const body = requestError?.response?.data;
      const detail =
        typeof body === 'string' && body
          ? body
          : requestError?.message || String(requestError);
      logger?.error(`Error creating transport: ${detail}`);
      return return_error(`Failed to create transport: ${detail}`);
    }

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      parseAttributeValue: false,
    });
    const parsed = parser.parse(response.data);
    const root = parsed['tm:root'] || parsed.root || {};
    const request = root['tm:request'] || {};
    const task = request['tm:task'] || {};

    const transportNumber = request['tm:number'];
    const actualTarget = request['tm:target'];

    // The client used to report the requested target back to the caller
    // regardless of what SAP did, so a request silently downgraded to LOCAL
    // looked like it had been created against the intended system.
    const warnings: string[] = [];
    if (
      requestedTarget &&
      actualTarget &&
      String(actualTarget).toUpperCase() !== requestedTarget
    ) {
      warnings.push(
        `Requested target "${requestedTarget}" but SAP assigned "${actualTarget}". The transport was NOT created against the requested system. Check that "${requestedTarget}" is a valid transport target in STMS for this package's transport layer.`,
      );
    }
    if (!transportNumber) {
      warnings.push(
        'SAP did not return a transport number; the request may not have been created.',
      );
    }

    logger?.info(
      `CreateTransport finished: ${transportNumber ?? 'no number'} target=${actualTarget ?? 'unknown'}`,
    );

    return return_response({
      data: JSON.stringify(
        {
          success: !!transportNumber && warnings.length === 0,
          transport_request: transportNumber,
          description: request['tm:desc'] || description,
          type: request['tm:type'] || transportType,
          requested_target: requestedTarget || 'LOCAL',
          target_system: actualTarget,
          target_desc: request['tm:target_desc'],
          cts_project: request['tm:cts_project'],
          owner: task['tm:owner'] || request['tm:owner'] || owner,
          uri: request['tm:uri'],
          warnings: warnings.length > 0 ? warnings : undefined,
          message: transportNumber
            ? `Transport request ${transportNumber} created`
            : 'Transport request creation returned no number',
        },
        null,
        2,
      ),
      status: response.status || 200,
      statusText: response.statusText || 'OK',
      headers: (response.headers || {}) as any,
      config: response.config || ({} as any),
    });
  } catch (error: any) {
    return return_error(error);
  }
}
