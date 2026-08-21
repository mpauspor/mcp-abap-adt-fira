import { AdtExecutor } from '@mcp-abap-adt/adt-clients';
import type { IAbapConnection, ILogger } from '@mcp-abap-adt/interfaces';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import {
  encodeSapObjectName,
  makeAdtRequestWithTimeout,
  return_error,
  return_response,
} from '../../../lib/utils';

/**
 * SAP's answer when the runtime load does not expose if_oo_adt_classrun~main.
 * Matches the message rather than a status code, because the endpoint returns
 * 200 and puts the failure in the body.
 */
const STALE_LOAD_PATTERN = /does not implement if_oo_adt_classrun~main/i;

async function readClassSource(
  connection: IAbapConnection,
  className: string,
  version: 'active' | 'inactive',
): Promise<string | undefined> {
  try {
    const response = await makeAdtRequestWithTimeout(
      connection,
      `/sap/bc/adt/oo/classes/${encodeSapObjectName(
        className,
      ).toLowerCase()}/source/main?version=${version}`,
      'GET',
      'default',
      undefined,
      undefined,
      { Accept: 'text/plain' },
    );
    return typeof response.data === 'string' ? response.data : undefined;
  } catch {
    // Having no inactive version is the normal case, and a failed probe must
    // never block the run the caller actually asked for.
    return undefined;
  }
}

/**
 * Detect a class whose source has been changed but not activated.
 *
 * SAP executes the ACTIVE load. After an update-without-activate, running the
 * class silently returns the previous version's output — or fails with
 * "does not implement if_oo_adt_classrun~main" when it is the interface itself
 * that was added in the unactivated version. Both look like the tool caching
 * results, which sends the caller looking for a cache that does not exist.
 * Naming the real cause is worth one extra request.
 */
async function findStaleActiveVersion(
  connection: IAbapConnection,
  className: string,
  logger?: ILogger,
): Promise<string | undefined> {
  const [active, inactive] = await Promise.all([
    readClassSource(connection, className, 'active'),
    readClassSource(connection, className, 'inactive'),
  ]);

  if (inactive === undefined) return undefined;

  if (active === undefined) {
    logger?.warn(`${className} has an inactive version but no active version`);
    return `Class ${className} has no active version — only an inactive one. Activate it before running.`;
  }

  if (active.replace(/\r\n/g, '\n') !== inactive.replace(/\r\n/g, '\n')) {
    logger?.warn(`${className} has unactivated changes; active load is stale`);
    return `Class ${className} has unactivated changes. SAP runs the ACTIVE version, so this execution would return output from the previous version. Activate the class (ActivateObjects with type CLAS/OC) and run again.`;
  }

  return undefined;
}

export const TOOL_DEFINITION = {
  name: 'RuntimeRunClass',
  available_in: ['onprem', 'cloud'] as const,
  description:
    '[runtime] Execute an ABAP class implementing if_oo_adt_classrun and return its output. Set profile=true to also capture a profiler trace (returns profilerId/traceId alongside output).',
  inputSchema: {
    type: 'object',
    properties: {
      class_name: {
        type: 'string',
        description: 'ABAP class name to execute.',
      },
      profile: {
        type: 'boolean',
        description:
          'When true, run with the profiler and resolve the resulting traceId. Default false.',
      },
      skip_activation_check: {
        type: 'boolean',
        description:
          "Skip the pre-flight check for unactivated changes. Default false. The check exists because SAP runs the ACTIVE load: with unactivated changes the run returns the previous version's output, which is indistinguishable from a caching bug.",
      },
      description: {
        type: 'string',
        description:
          'Profiler trace description (only used when profile=true).',
      },
      all_procedural_units: { type: 'boolean' },
      all_misc_abap_statements: { type: 'boolean' },
      all_internal_table_events: { type: 'boolean' },
      all_dynpro_events: { type: 'boolean' },
      aggregate: { type: 'boolean' },
      explicit_on_off: { type: 'boolean' },
      with_rfc_tracing: { type: 'boolean' },
      all_system_kernel_events: { type: 'boolean' },
      sql_trace: { type: 'boolean' },
      all_db_events: { type: 'boolean' },
      max_size_for_trace_file: { type: 'number' },
      amdp_trace: { type: 'boolean' },
      max_time_for_tracing: { type: 'number' },
      max_trace_attempts: {
        type: 'integer',
        minimum: 1,
        description:
          'Max polling attempts to resolve traceId after execution (default 5). Only used when profile=true.',
      },
      trace_retry_delay_ms: {
        type: 'integer',
        minimum: 0,
        description:
          'Delay in ms between trace polling attempts (default 2000). Only used when profile=true.',
      },
      trace_lookup_uris: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        description:
          'Additional URIs to consult when resolving the trace (advanced, profile=true).',
      },
    },
    required: ['class_name'],
  },
} as const;

interface RuntimeRunClassArgs {
  class_name: string;
  profile?: boolean;
  skip_activation_check?: boolean;
  description?: string;
  all_procedural_units?: boolean;
  all_misc_abap_statements?: boolean;
  all_internal_table_events?: boolean;
  all_dynpro_events?: boolean;
  aggregate?: boolean;
  explicit_on_off?: boolean;
  with_rfc_tracing?: boolean;
  all_system_kernel_events?: boolean;
  sql_trace?: boolean;
  all_db_events?: boolean;
  max_size_for_trace_file?: number;
  amdp_trace?: boolean;
  max_time_for_tracing?: number;
  max_trace_attempts?: number;
  trace_retry_delay_ms?: number;
  trace_lookup_uris?: string[];
}

export async function handleRuntimeRunClass(
  context: HandlerContext,
  args: RuntimeRunClassArgs,
) {
  const { connection, logger } = context;

  try {
    if (!args?.class_name) {
      throw new Error('Parameter "class_name" is required');
    }

    const className = args.class_name.trim().toUpperCase();

    // Fail loudly on a stale active load rather than returning last version's
    // output as though it were this version's.
    if (args.skip_activation_check !== true) {
      const staleReason = await findStaleActiveVersion(
        connection,
        className,
        logger,
      );
      if (staleReason) {
        return return_error(
          new Error(
            `${staleReason} Pass skip_activation_check=true to run the active version anyway.`,
          ),
        );
      }
    }

    const executor = new AdtExecutor(connection, logger);
    const classExecutor = executor.getClassExecutor();

    if (!args.profile) {
      const response = await classExecutor.run({ className });

      // SAP answers 200 and puts "does not implement if_oo_adt_classrun~main"
      // in the BODY, so this failure would otherwise be handed back as though
      // it were the class's own output. Two very different causes produce it,
      // and the source settles which: either the class really lacks the
      // interface, or its runtime load is stale.
      //
      // Observed on a 7.5x system: a freshly created class whose first update ADDS the
      // interface stays unrunnable even though activation reports success and
      // the active source declares the interface. Waiting does not clear it
      // (a 2s retry was tried and does not work) — a further activation run
      // does. This handler will not activate anything on the caller's behalf,
      // so it reports the situation precisely instead.
      if (STALE_LOAD_PATTERN.test(String(response.data ?? ''))) {
        const activeSource =
          (await readClassSource(connection, className, 'active')) ?? '';
        const declaresInterface = /if_oo_adt_classrun/i.test(activeSource);

        return return_error(
          new Error(
            declaresInterface
              ? `Class ${className} reports that it does not implement if_oo_adt_classrun~main, but its ACTIVE source does declare the interface. The runtime load is stale. Observed cause: a newly created class that had the interface added in its first update. Note that re-running ActivateObjects does NOT fix this — SAP answers activationExecuted="false" for an already-active class and the load is not regenerated. What does work is an activation that actually activates something: change the source (even trivially), then activate; or delete and re-create the class with the interface present from the start.`
              : `Class ${className} does not implement if_oo_adt_classrun~main. Add "INTERFACES if_oo_adt_classrun." to the public section and implement if_oo_adt_classrun~main.`,
          ),
        );
      }
      return return_response({
        data: JSON.stringify(
          {
            success: true,
            class_name: className,
            output: typeof response.data === 'string' ? response.data : '',
            run_status: response.status,
          },
          null,
          2,
        ),
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        config: response.config,
      });
    }

    const maxTraceAttempts =
      typeof args.max_trace_attempts === 'number' &&
      Number.isFinite(args.max_trace_attempts) &&
      args.max_trace_attempts >= 1
        ? Math.trunc(args.max_trace_attempts)
        : undefined;
    const traceRetryDelayMs =
      typeof args.trace_retry_delay_ms === 'number' &&
      Number.isFinite(args.trace_retry_delay_ms) &&
      args.trace_retry_delay_ms >= 0
        ? Math.trunc(args.trace_retry_delay_ms)
        : undefined;
    const traceLookupUris = Array.isArray(args.trace_lookup_uris)
      ? args.trace_lookup_uris.filter(
          (uri): uri is string => typeof uri === 'string' && uri.length > 0,
        )
      : undefined;

    const result = await classExecutor.runWithProfiling(
      { className },
      {
        maxTraceAttempts,
        traceRetryDelayMs,
        traceLookupUris,
        profilerParameters: {
          description: args.description,
          allProceduralUnits: args.all_procedural_units,
          allMiscAbapStatements: args.all_misc_abap_statements,
          allInternalTableEvents: args.all_internal_table_events,
          allDynproEvents: args.all_dynpro_events,
          aggregate: args.aggregate,
          explicitOnOff: args.explicit_on_off,
          withRfcTracing: args.with_rfc_tracing,
          allSystemKernelEvents: args.all_system_kernel_events,
          sqlTrace: args.sql_trace,
          allDbEvents: args.all_db_events,
          maxSizeForTraceFile: args.max_size_for_trace_file,
          amdpTrace: args.amdp_trace,
          maxTimeForTracing: args.max_time_for_tracing,
        },
      },
    );

    return return_response({
      data: JSON.stringify(
        {
          success: true,
          class_name: className,
          output:
            typeof result.response?.data === 'string'
              ? result.response.data
              : '',
          run_status: result.response?.status,
          profile: {
            profiler_id: result.profilerId,
            trace_id: result.traceId,
            trace_requests_status: result.traceRequestsResponse?.status,
          },
        },
        null,
        2,
      ),
      status: result.response?.status,
      statusText: result.response?.statusText,
      headers: result.response?.headers,
      config: result.response?.config,
    });
  } catch (error: any) {
    logger?.error('Error running class:', error);
    return return_error(error);
  }
}
