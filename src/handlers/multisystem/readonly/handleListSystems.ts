/**
 * ListSystems - enumerate the SAP systems available for cross-system comparison.
 *
 * The comparison tools address a system by NAME, so this is how a caller finds
 * out which names exist and where to define a new one.
 */

import {
  currentSystemInfo,
  listAvailableSystems,
  sessionsDirectories,
} from '../../../lib/adt/secondarySystem';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import { return_error, return_response } from '../../../lib/utils';

export const TOOL_DEFINITION = {
  name: 'ListSystems',
  available_in: ['onprem', 'cloud', 'legacy'] as const,
  description:
    '[read-only] List the SAP systems this server can reach for cross-system comparison, plus the system it is itself connected to. Use the returned names with CompareObjectAcrossSystems and ComparePackageAcrossSystems. Reports connection metadata only — never credentials.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
} as const;

export async function handleListSystems(
  context: HandlerContext,
  _args: unknown,
) {
  const { connection, logger } = context;
  try {
    const systems = listAvailableSystems();
    const directories = sessionsDirectories();

    const usable = systems.filter((system) => system.has_credentials);

    logger?.info(
      `ListSystems: ${systems.length} defined, ${usable.length} with credentials`,
    );

    return return_response({
      data: JSON.stringify(
        {
          success: true,
          current_system: await currentSystemInfo(connection),
          comparison_systems: systems,
          count: systems.length,
          sessions_directories: directories,
          hint:
            systems.length === 0
              ? `No comparison systems are defined. Create ${directories[0] ?? '<sessions dir>'}/<name>.env with SAP_URL, SAP_CLIENT, SAP_USERNAME, SAP_PASSWORD, SAP_SYSTEM_TYPE — then use <name> as target_system. A READ-ONLY SAP user is strongly recommended for QAS/PRD.`
              : undefined,
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
    logger?.error(`ListSystems failed: ${error?.message || error}`);
    return return_error(error);
  }
}
