/**
 * UpdateInclude Handler - Update ABAP include source code
 *
 * Workflow: lock -> upload source -> unlock -> read back and verify -> (activate)
 *
 * Exists because there was previously no way to write an include at all:
 * `UpdateProgram` routes through `/sap/bc/adt/programs/programs/`, which is the
 * wrong resource for an include, and reported success regardless.
 */

import { activateObjectsGroup } from '../../../lib/adt/groupActivation';
import {
  lockInclude,
  readIncludeSource,
  unlockInclude,
  uploadIncludeSource,
} from '../../../lib/adt/includeSource';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import {
  parseActivationResponse,
  return_error,
  return_response,
} from '../../../lib/utils';
import { verifySourceWritten } from '../../../lib/verifyWrite';

export const TOOL_DEFINITION = {
  name: 'UpdateInclude',
  available_in: ['onprem', 'legacy'] as const,
  description:
    'Operation: Update. Subject: Include. Update the source code of an existing ABAP include (PROG/I). This is the correct tool for include names — UpdateProgram targets a different ADT resource and will not write an include. Locks, updates, unlocks, verifies the write by reading the source back, and optionally activates.',
  inputSchema: {
    type: 'object',
    properties: {
      include_name: {
        type: 'string',
        description: 'Include name (e.g., ZXY_INCLUDE). Must already exist.',
      },
      source_code: {
        type: 'string',
        description: 'Complete ABAP include source code.',
      },
      transport_request: {
        type: 'string',
        description:
          'Transport request number (e.g., E19K905635). Required for transportable packages.',
      },
      activate: {
        type: 'boolean',
        description:
          'Activate the include after the source update. Default: false.',
      },
    },
    required: ['include_name', 'source_code'],
  },
} as const;

interface UpdateIncludeArgs {
  include_name: string;
  source_code: string;
  transport_request?: string;
  activate?: boolean;
}

export async function handleUpdateInclude(
  context: HandlerContext,
  params: UpdateIncludeArgs,
) {
  const { connection, logger } = context;
  const args = params;

  if (!args?.include_name || args?.source_code === undefined) {
    return return_error(
      new Error('Missing required parameters: include_name and source_code'),
    );
  }

  const includeName = args.include_name.toUpperCase();
  const shouldActivate = args.activate === true;

  logger?.info(
    `Starting include source update: ${includeName} (activate=${shouldActivate})`,
  );

  try {
    let lockHandle: string | undefined;

    // ADT ties a lock handle to a stateful ABAP session. Without this the lock
    // is issued against one session and the PUT arrives on another, and SAP
    // rejects it with 423 ExceptionResourceInvalidLockHandle — the lock looks
    // fine, the write never lands.
    connection.setSessionType('stateful');

    try {
      logger?.debug(`Locking include: ${includeName}`);
      lockHandle = await lockInclude(connection, includeName);

      logger?.debug(`Uploading include source: ${includeName}`);
      await uploadIncludeSource(
        connection,
        includeName,
        args.source_code,
        lockHandle,
        args.transport_request,
      );
      logger?.info(`Include source uploaded: ${includeName}`);
    } finally {
      if (lockHandle) {
        try {
          await unlockInclude(connection, includeName, lockHandle);
          logger?.info(`Include unlocked: ${includeName}`);
        } catch (unlockError: any) {
          logger?.warn(
            `Failed to unlock include ${includeName}: ${unlockError?.message || unlockError}`,
          );
        }
      }
      // Back to stateless so the session is not pinned for later reads.
      connection.setSessionType('stateless');
    }

    // Read back before claiming anything. A 200 on the PUT is not evidence
    // that this object now holds this source.
    const verification = await verifySourceWritten(
      () => readIncludeSource(connection, includeName),
      args.source_code,
      `Include ${includeName}`,
      logger,
    );

    if (!verification.verified) {
      return return_error(
        new Error(
          `Include ${includeName} update could not be confirmed: ${verification.reason}`,
        ),
      );
    }

    let activationResult: any;
    if (shouldActivate) {
      logger?.debug(`Activating include: ${includeName}`);
      const responseData = await activateObjectsGroup(
        connection,
        [{ name: includeName, type: 'PROG/I' }],
        true,
        logger,
      );
      activationResult = parseActivationResponse(responseData);
    }

    const activationErrors =
      activationResult?.messages?.filter(
        (m: any) => m.type === 'error' || m.type === 'E',
      ) ?? [];

    const result = {
      success: activationErrors.length === 0,
      include_name: includeName,
      type: 'PROG/I',
      uri: `/sap/bc/adt/programs/includes/${includeName.toLowerCase()}`,
      activated: shouldActivate && activationErrors.length === 0,
      write_verified: true,
      source_size_bytes: args.source_code.length,
      steps_completed: [
        'lock',
        'update',
        'unlock',
        'verify_read_back',
        ...(shouldActivate ? ['activate'] : []),
      ],
      activation_messages: activationResult?.messages,
      activation_errors:
        activationErrors.length > 0 ? activationErrors : undefined,
      message: shouldActivate
        ? `Include ${includeName} source updated (verified) and activation attempted`
        : `Include ${includeName} source updated and verified (not activated)`,
    };

    return return_response({
      data: JSON.stringify(result, null, 2),
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.error(`Error updating include ${includeName}: ${message}`);
    return return_error(
      new Error(`Failed to update include ${includeName}: ${message}`),
    );
  }
}
