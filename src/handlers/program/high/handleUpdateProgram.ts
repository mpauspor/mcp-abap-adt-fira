/**
 * UpdateProgram Handler - Update Existing ABAP Program Source Code
 *
 * Workflow: lock -> check (new code) -> update (if check OK) -> unlock -> check (inactive) -> (activate)
 */

import { XMLParser } from 'fast-xml-parser';
import { isInclude } from '../../../lib/adt/includeSource';
import { createAdtClient } from '../../../lib/clients';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import {
  encodeSapObjectName,
  isCloudConnection,
  makeAdtRequestWithTimeout,
  return_error,
  return_response,
  safeCheckOperation,
} from '../../../lib/utils';
import { verifySourceWritten } from '../../../lib/verifyWrite';

/** Read a program's source back, to substantiate the success claim. */
async function readProgramSource(
  connection: any,
  programName: string,
): Promise<string> {
  const response = await makeAdtRequestWithTimeout(
    connection,
    `/sap/bc/adt/programs/programs/${encodeSapObjectName(
      programName,
    ).toLowerCase()}/source/main`,
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

export const TOOL_DEFINITION = {
  name: 'UpdateProgram',
  available_in: ['onprem', 'legacy'] as const,
  description:
    'Operation: Update, Create. Subject: Program. Will be useful for updating or creating program. Update source code of an existing ABAP program. Locks, updates, unlocks, and optionally activates.',
  inputSchema: {
    type: 'object',
    properties: {
      program_name: {
        type: 'string',
        description:
          'Program name (e.g., Z_TEST_PROGRAM_001). Program must already exist.',
      },
      source_code: {
        type: 'string',
        description: 'Complete ABAP program source code.',
      },
      transport_request: {
        type: 'string',
        description:
          'Transport request number (e.g., E19K905635). Required for transportable packages.',
      },
      activate: {
        type: 'boolean',
        description:
          'Activate program after source update. Default: false. Set to true to activate immediately, or use ActivateObject for batch activation.',
      },
    },
    required: ['program_name', 'source_code'],
  },
} as const;

interface UpdateProgramArgs {
  program_name: string;
  source_code: string;
  transport_request?: string;
  activate?: boolean;
}

export async function handleUpdateProgram(
  context: HandlerContext,
  params: any,
) {
  const { connection, logger } = context;
  const args: UpdateProgramArgs = params;

  // Validate required parameters
  if (!args.program_name || !args.source_code) {
    return return_error(
      new Error('Missing required parameters: program_name and source_code'),
    );
  }

  // Check if cloud - programs are not available on cloud systems
  if (isCloudConnection()) {
    return return_error(
      new Error(
        'Programs are not available on cloud systems (ABAP Cloud). This operation is only supported on on-premise systems.',
      ),
    );
  }

  const programName = args.program_name.toUpperCase();
  logger?.info(
    `Starting program source update: ${programName} (activate=${args.activate === true})`,
  );

  // An include addressed through the program resource is the failure this
  // guard exists for: SAP answers lock, PUT and unlock without complaint and
  // the include is left untouched. Refuse rather than report a write that did
  // not happen.
  if (await isInclude(connection, programName)) {
    return return_error(
      new Error(
        `${programName} is an include (PROG/I), not a program. UpdateProgram writes to /sap/bc/adt/programs/programs/, which is the wrong ADT resource for an include and would silently fail to write. Use UpdateInclude instead.`,
      ),
    );
  }

  // Connection setup
  try {
    // Get connection from session context (set by ProtocolHandler)
    // Connection is managed and cached per session, with proper token refresh via AuthBroker
    logger?.debug(
      `Created separate connection for handler call: ${programName}`,
    );
  } catch (connectionError: any) {
    const errorMessage =
      connectionError instanceof Error
        ? connectionError.message
        : String(connectionError);
    logger?.error(`Failed to create connection: ${errorMessage}`);
    return return_error(
      new Error(`Failed to create connection: ${errorMessage}`),
    );
  }

  try {
    const client = createAdtClient(connection, logger);
    const shouldActivate = args.activate === true; // Default to false if not specified
    let lockHandle: string | undefined;
    let activateResponse: any | undefined;

    try {
      // Lock
      logger?.debug(`Locking program: ${programName}`);
      lockHandle = await client.getProgram().lock({ programName });
      logger?.debug(
        `Program locked: ${programName} (handle=${lockHandle ? `${lockHandle.substring(0, 8)}...` : 'none'})`,
      );

      // Check new code BEFORE update (only when activating)
      if (shouldActivate) {
        logger?.debug(`Checking new source code before update: ${programName}`);
        try {
          await safeCheckOperation(
            () =>
              client
                .getProgram()
                .check(
                  { programName, sourceCode: args.source_code },
                  'inactive',
                ),
            programName,
            {
              debug: (message: string) => logger?.debug(message),
            },
          );
          logger?.debug(`New code check passed: ${programName}`);
        } catch (checkError: any) {
          if ((checkError as any).isAlreadyChecked) {
            logger?.debug(
              `Program ${programName} was already checked - continuing`,
            );
          } else {
            logger?.error(
              `New code check failed: ${programName} - ${checkError instanceof Error ? checkError.message : String(checkError)}`,
            );
            throw new Error(
              `New code check failed: ${checkError instanceof Error ? checkError.message : String(checkError)}`,
            );
          }
        }
      } else {
        logger?.debug(`Skipping syntax check (activate=false): ${programName}`);
      }

      // Update
      logger?.debug(`Updating program source code: ${programName}`);
      await client.getProgram().update(
        {
          programName,
          sourceCode: args.source_code,
          transportRequest: args.transport_request,
        },
        { lockHandle },
      );
      logger?.info(`Program source code updated: ${programName}`);
    } finally {
      if (lockHandle) {
        try {
          logger?.debug(`Unlocking program: ${programName}`);
          await client.getProgram().unlock({ programName }, lockHandle);
          logger?.info(`Program unlocked: ${programName}`);
        } catch (unlockError: any) {
          logger?.warn(
            `Failed to unlock program ${programName}: ${unlockError?.message || unlockError}`,
          );
        }
      }
    }

    // Confirm the source actually landed on this object before reporting
    // success. Without this, a write that SAP accepts but does not apply is
    // indistinguishable from one that worked.
    const verification = await verifySourceWritten(
      () => readProgramSource(connection, programName),
      args.source_code,
      `Program ${programName}`,
      logger,
    );

    if (!verification.verified) {
      return return_error(
        new Error(
          `Program ${programName} update could not be confirmed: ${verification.reason}`,
        ),
      );
    }

    // Check inactive version (after unlock, only when activating)
    if (shouldActivate) {
      logger?.debug(`Checking inactive version: ${programName}`);
      try {
        await safeCheckOperation(
          () => client.getProgram().check({ programName }, 'inactive'),
          programName,
          {
            debug: (message: string) => logger?.debug(message),
          },
        );
        logger?.debug(`Inactive version check completed: ${programName}`);
      } catch (checkError: any) {
        if ((checkError as any).isAlreadyChecked) {
          logger?.debug(
            `Program ${programName} was already checked - continuing`,
          );
        } else {
          logger?.warn(
            `Inactive version check had issues: ${programName} - ${checkError instanceof Error ? checkError.message : String(checkError)}`,
          );
        }
      }
    }

    // Activate if requested
    if (shouldActivate) {
      logger?.debug(`Activating program: ${programName}`);
      try {
        const activateState = await client.getProgram().activate({
          programName,
        });
        activateResponse = activateState.activateResult;
        logger?.info(`Program activated: ${programName}`);
      } catch (activationError: any) {
        logger?.error(
          `Activation failed: ${programName} - ${activationError instanceof Error ? activationError.message : String(activationError)}`,
        );
        throw new Error(
          `Activation failed: ${activationError instanceof Error ? activationError.message : String(activationError)}`,
        );
      }
    } else {
      logger?.debug(`Skipping activation for: ${programName}`);
    }

    // Parse activation warnings if activation was performed
    let activationWarnings: string[] = [];
    if (
      shouldActivate &&
      activateResponse &&
      typeof activateResponse.data === 'string' &&
      activateResponse.data.includes('<chkl:messages')
    ) {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
      });
      const result = parser.parse(activateResponse.data);
      const messages = result?.['chkl:messages']?.msg;
      if (messages) {
        const msgArray = Array.isArray(messages) ? messages : [messages];
        activationWarnings = msgArray.map(
          (msg: any) => `${msg['@_type']}: ${msg.shortText?.txt || 'Unknown'}`,
        );
      }
    }

    logger?.info(`UpdateProgram completed successfully: ${programName}`);

    const result = {
      success: true,
      program_name: programName,
      type: 'PROG/P',
      activated: shouldActivate,
      message: shouldActivate
        ? `Program ${programName} source updated and activated successfully`
        : `Program ${programName} source updated successfully (not activated)`,
      uri: `/sap/bc/adt/programs/programs/${encodeSapObjectName(programName).toLowerCase()}`,
      write_verified: true,
      steps_completed: [
        'lock',
        'check_new_code',
        'update',
        'unlock',
        'verify_read_back',
        'check_inactive',
        ...(shouldActivate ? ['activate'] : []),
      ],
      activation_warnings:
        activationWarnings.length > 0 ? activationWarnings : undefined,
      source_size_bytes: args.source_code.length,
    };

    return return_response({
      data: JSON.stringify(result, null, 2),
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    });
  } catch (error: any) {
    // Parse error message
    let errorMessage = error instanceof Error ? error.message : String(error);

    // Attempt to parse ADT XML error
    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
      });
      const errorData = error?.response?.data
        ? parser.parse(error.response.data)
        : null;
      const errorMsg =
        errorData?.['exc:exception']?.message?.['#text'] ||
        errorData?.['exc:exception']?.message;
      if (errorMsg) {
        errorMessage = `SAP Error: ${errorMsg}`;
      }
    } catch {
      // ignore parse errors
    }

    logger?.error(
      `Error updating program source ${programName}: ${errorMessage}`,
    );
    return return_error(
      new Error(`Failed to update program ${programName}: ${errorMessage}`),
    );
  }
}
