/**
 * ActivateObject Handler - Universal ABAP Object Activation via ADT API
 */

import { activateObjectsGroup } from '../../../lib/adt/groupActivation';
import type { ObjectUriRequest } from '../../../lib/adt/objectUri';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import {
  parseActivationResponse,
  return_error,
  return_response,
} from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'ActivateObjectLow',
  available_in: ['onprem', 'cloud', 'legacy'] as const,
  description:
    '[low-level] Activate one or multiple ABAP repository objects. URI is derived from name and type; pass an explicit uri to override.',
  inputSchema: {
    type: 'object',
    properties: {
      objects: {
        type: 'array',
        description:
          "Array of objects to activate. Each object must have 'name' and 'type'. URI is optional.",
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name in uppercase' },
            type: {
              type: 'string',
              description:
                "Object type code (e.g., 'CLAS/OC', 'PROG/P', 'PROG/I' for includes, 'DDLS/DF')",
            },
            uri: {
              type: 'string',
              description:
                'Optional explicit ADT URI. Overrides the URI derived from name and type.',
            },
            parent_name: {
              type: 'string',
              description:
                'Parent object name. Required for function modules (FUGR/FF), where it is the function group.',
            },
          },
          required: ['name', 'type'],
        },
      },
      preaudit: {
        type: 'boolean',
        description: 'Request pre-audit before activation. Default: true',
      },
    },
    required: ['objects'],
  },
} as const;

interface ActivationObject {
  name: string;
  type?: string;
  uri?: string;
  parent_name?: string;
}

interface ActivateObjectArgs {
  objects: ActivationObject[];
  preaudit?: boolean;
}

export async function handleActivateObject(
  context: HandlerContext,
  params: ActivateObjectArgs,
) {
  const { connection, logger } = context;
  try {
    const args = params;

    if (
      !args.objects ||
      !Array.isArray(args.objects) ||
      args.objects.length === 0
    ) {
      return return_error(
        new Error(
          'Missing required parameter: objects (must be non-empty array)',
        ),
      );
    }

    const preaudit = args.preaudit !== false; // default true

    logger?.info(`Starting activation of ${args.objects.length} object(s)`);

    try {
      // `uri` and `parent_name` are carried through rather than dropped: an
      // include cannot be addressed without the first, a function module
      // without the second.
      const activationObjects: ObjectUriRequest[] = args.objects.map((obj) => ({
        name: obj.name.toUpperCase(),
        type: obj.type,
        uri: obj.uri,
        parentName: obj.parent_name,
      }));

      logger?.debug(
        `Activating objects: ${activationObjects.map((o) => o.name).join(', ')}`,
      );

      const responseData = await activateObjectsGroup(
        connection,
        activationObjects,
        preaudit,
        logger,
      );

      const activationResult = parseActivationResponse(responseData);

      // Success is the absence of error-severity messages, NOT
      // `activated && checked`. SAP answers activationExecuted="false" for an
      // object that is already active and needs no work, so the old test
      // reported a failure for a perfectly good no-op — and, worse, ignored
      // the <msg type="E"> list that carries the real reason when something
      // does go wrong.
      const errorMessages = activationResult.messages.filter(
        (m: any) => m.type === 'error' || m.type === 'E',
      );
      const success = errorMessages.length === 0;

      const result = {
        success,
        objects_count: args.objects.length,
        objects: activationObjects.map((obj) => ({
          name: obj.name,
          type: obj.type,
          uri: obj.uri,
        })),
        activation: {
          activated: activationResult.activated,
          checked: activationResult.checked,
          generated: activationResult.generated,
        },
        messages: activationResult.messages,
        warnings: activationResult.messages.filter(
          (m: any) => m.type === 'warning' || m.type === 'W',
        ),
        errors: errorMessages,
        message: success
          ? activationResult.activated
            ? `Successfully activated ${args.objects.length} object(s)`
            : `Nothing to activate — object(s) already active`
          : `Activation failed with ${errorMessages.length} error(s)`,
      };

      logger?.info(
        `Activation completed: ${success ? 'SUCCESS' : 'WITH ISSUES'}`,
      );

      return return_response({
        data: JSON.stringify(result, null, 2),
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      });
    } catch (error: any) {
      logger?.error('Error during activation', error);

      let errorMessage: string;
      if (error.response?.data) {
        if (typeof error.response.data === 'string') {
          errorMessage = error.response.data;
        } else {
          try {
            errorMessage = JSON.stringify(error.response.data);
          } catch {
            errorMessage = `HTTP ${error.response.status}: ${error.response.statusText || 'Error'}`;
          }
        }
      } else {
        errorMessage = error.message || String(error);
      }

      return return_error(
        new Error(`Failed to activate objects: ${errorMessage}`),
      );
    }
  } catch (error: any) {
    return return_error(error);
  }
}
