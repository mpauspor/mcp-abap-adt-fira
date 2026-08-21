/**
 * Post-write verification for objects edited through structured metadata.
 *
 * Domains, data elements, message classes, function groups and service bindings
 * are not written as source, so the byte comparison that guards the source
 * tools cannot work on them: SAP generates their payload, and comparing it
 * against the caller's arguments would report a mismatch on every successful
 * write. They were therefore the last group still reporting `success` from the
 * mere absence of an exception.
 *
 * Two checks, chosen per tool by what that tool actually writes:
 *
 * - Four of the five accept a `description`, and their read exposes it. That is
 *   compared directly, so the check confirms the value that landed rather than
 *   merely that something moved.
 * - `UpdateServiceBinding` writes no comparable field — it publishes or
 *   unpublishes — so it is verified by `changedAt` advancing.
 *
 * Both were established by probing a live system: the argument names come from
 * the registered tool definitions, and the shape of each read (raw XML for
 * DDIC, parsed JSON for message classes and service bindings) from the
 * responses themselves.
 */

import type { ILogger } from '@mcp-abap-adt/interfaces';
import type { HandlerContext } from './handlers/interfaces';

/** Reads an object and returns whatever text the tool produces. */
export type MetadataReader = (
  context: HandlerContext,
  args: any,
) => Promise<any>;

export interface MetadataWriteDescriptor {
  /** Handler argument carrying the object name. Taken from the tool definitions. */
  nameArg: string;
  /**
   * `description` compares the field the caller asked for; `changedAt` checks
   * that SAP's change timestamp advanced.
   */
  check: 'description' | 'changedAt';
  /** The Get* handler for this type — it knows the media type the read needs. */
  read: () => Promise<MetadataReader>;
  /**
   * Whether the reader accepts a `version`. An update made without activating
   * writes the INACTIVE version, so reading only the active one would report a
   * false failure; both are consulted where possible.
   */
  hasVersions: boolean;
  label: string;
}

/**
 * The tools this applies to.
 *
 * Readers are imported lazily so registering the tools does not pull five more
 * handler modules into every startup.
 */
export const METADATA_WRITE_TOOLS: Record<string, MetadataWriteDescriptor> = {
  UpdateDomain: {
    nameArg: 'domain_name',
    check: 'description',
    hasVersions: true,
    label: 'Domain',
    read: async () =>
      (await import('../handlers/domain/high/handleGetDomain.js'))
        .handleGetDomain,
  },
  UpdateDataElement: {
    nameArg: 'data_element_name',
    check: 'description',
    hasVersions: true,
    label: 'Data element',
    read: async () =>
      (await import('../handlers/data_element/high/handleGetDataElement.js'))
        .handleGetDataElement,
  },
  UpdateMessageClass: {
    nameArg: 'message_class_name',
    check: 'description',
    hasVersions: false,
    label: 'Message class',
    read: async () =>
      (await import('../handlers/message_class/high/handleGetMessageClass.js'))
        .handleGetMessageClass,
  },
  UpdateFunctionGroup: {
    nameArg: 'function_group_name',
    check: 'description',
    hasVersions: true,
    label: 'Function group',
    read: async () =>
      (
        await import(
          '../handlers/function_group/high/handleGetFunctionGroup.js'
        )
      ).handleGetFunctionGroup,
  },
  UpdateServiceBinding: {
    nameArg: 'service_binding_name',
    check: 'changedAt',
    hasVersions: false,
    label: 'Service binding',
    read: async () =>
      (
        await import(
          '../handlers/service_binding/high/handleGetServiceBinding.js'
        )
      ).handleGetServiceBinding,
  },
};

function responseText(result: any): string {
  const text = result?.content?.[0]?.text;
  return typeof text === 'string' ? text : '';
}

/** Look for `field` on the object or one level down, where the readers put it. */
function findShallow(value: any, field: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const direct = value[field];
  if (typeof direct === 'string') return direct;
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === 'object') {
      const hit = (nested as any)[field];
      if (typeof hit === 'string') return hit;
    }
  }
  return undefined;
}

/**
 * Read one field from a response, whichever shape it arrives in.
 *
 * DDIC reads return raw XML inside a JSON envelope, so the attribute form has
 * to be matched textually; message classes and service bindings return the
 * field already parsed. JSON is tried first so a nested XML attribute cannot
 * shadow the real value.
 */
function extractField(result: any, field: string): string | undefined {
  const text = responseText(result);
  if (!text) return undefined;

  try {
    const hit = findShallow(JSON.parse(text), field);
    if (hit !== undefined) return hit;
  } catch {
    // Not JSON, or not shaped as expected — fall through to the XML form.
  }

  // Matches both `adtcore:description="X"` and the escaped `...=\"X\"` form the
  // attribute takes once the XML is embedded in a JSON string.
  const pattern = new RegExp(`(?:adtcore:)?${field}=\\\\?"([^"\\\\]+)`);
  const match = text.match(pattern);
  return match ? match[1] : undefined;
}

/**
 * Collect a field from the active version and, where the reader supports it,
 * the inactive one. An update that did not activate writes only the inactive
 * version, and checking active alone would call that a failure.
 */
async function readField(
  descriptor: MetadataWriteDescriptor,
  context: HandlerContext,
  objectName: string,
  field: string,
): Promise<string[]> {
  const attempts: Array<Record<string, unknown>> = [
    { [descriptor.nameArg]: objectName },
  ];
  if (descriptor.hasVersions) {
    attempts.push({ [descriptor.nameArg]: objectName, version: 'inactive' });
  }

  const found: string[] = [];
  for (const args of attempts) {
    try {
      const reader = await descriptor.read();
      const value = extractField(await reader(context, args), field);
      if (value !== undefined) found.push(value);
    } catch {
      // A read that fails is not evidence the write failed.
    }
  }
  return found;
}

function annotate(result: any, fields: Record<string, unknown>): any {
  const entry = result?.content?.[0];
  if (typeof entry?.text !== 'string') return result;
  try {
    const payload = JSON.parse(entry.text);
    if (payload === null || typeof payload !== 'object') return result;
    return {
      ...result,
      content: [
        { ...entry, text: JSON.stringify({ ...payload, ...fields }, null, 2) },
        ...result.content.slice(1),
      ],
    };
  } catch {
    return result;
  }
}

function fail(message: string): any {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

const unverified = (result: any, why: string) =>
  annotate(result, {
    metadata_write_verified: false,
    metadata_verification_note: `${why} The update itself may well have been applied.`,
  });

/**
 * Wrap a metadata Update* handler so it confirms the write reached SAP.
 *
 * Failure policy matches the source tools: fail only on positive evidence that
 * nothing landed — a description that came back different, or a timestamp that
 * did not move. Anything unreadable is reported as unverified without failing,
 * because a read problem is not a write problem.
 */
export function withMetadataVerification<H extends (...args: any[]) => any>(
  toolName: string,
  handler: H,
  getContext: () => HandlerContext,
  getLogger?: () => ILogger | undefined,
): (...args: Parameters<H>) => Promise<Awaited<ReturnType<H>>> {
  const descriptor = METADATA_WRITE_TOOLS[toolName];
  if (!descriptor) {
    return handler as (
      ...args: Parameters<H>
    ) => Promise<Awaited<ReturnType<H>>>;
  }

  return async (...callArgs: Parameters<H>) => {
    const args: any = callArgs[callArgs.length - 1];
    const objectName = String(args?.[descriptor.nameArg] ?? '').toUpperCase();
    if (!objectName) return handler(...callArgs);

    const context = getContext();
    const logger = getLogger?.();
    const { label } = descriptor;

    if (descriptor.check === 'changedAt') {
      const before = await readField(
        descriptor,
        context,
        objectName,
        'changedAt',
      );
      const result = await handler(...callArgs);
      if (result?.isError) return result;
      const after = await readField(
        descriptor,
        context,
        objectName,
        'changedAt',
      );

      if (before.length === 0 || after.length === 0) {
        return unverified(
          result,
          `Could not read ${label} ${objectName} back to confirm the change.`,
        );
      }
      if (before[0] === after[0]) {
        logger?.error(
          `${label} ${objectName}: changedAt did not move (${after[0]}) — nothing was written`,
        );
        return fail(
          `${label} ${objectName} update could not be confirmed: SAP's change timestamp did not move (${after[0]}), so nothing was written to this object.`,
        );
      }
      return annotate(result, {
        metadata_write_verified: true,
        changed_at: after[0],
        metadata_verification_note:
          'SAP recorded a change on this object. This confirms the write landed; it does not verify each individual field.',
      });
    }

    const expected =
      typeof args?.description === 'string' ? args.description : undefined;
    const result = await handler(...callArgs);
    if (result?.isError) return result;

    if (expected === undefined) {
      return unverified(
        result,
        `No description was supplied, so there is no field to compare for ${label} ${objectName}.`,
      );
    }

    const observed = await readField(
      descriptor,
      context,
      objectName,
      'description',
    );
    if (observed.length === 0) {
      return unverified(
        result,
        `Could not read ${label} ${objectName} back to confirm the change.`,
      );
    }

    const wanted = expected.trim();
    const exact = observed.some((value) => value.trim() === wanted);
    // SAP truncates a description at the field length. That is a successful
    // write, not a mismatch.
    const truncated =
      !exact &&
      observed.some(
        (value) => value.trim().length > 0 && wanted.startsWith(value.trim()),
      );

    if (!exact && !truncated) {
      logger?.error(
        `${label} ${objectName}: description reads back as ${JSON.stringify(observed)}, expected ${JSON.stringify(wanted)}`,
      );
      return fail(
        `${label} ${objectName} update could not be confirmed: the description reads back as ${observed.map((value) => JSON.stringify(value)).join(' / ')}, but ${JSON.stringify(wanted)} was requested. The write did not land as asked.`,
      );
    }

    return annotate(result, {
      metadata_write_verified: true,
      metadata_verification_note: truncated
        ? 'Read back and confirmed; SAP truncated the description to the field length.'
        : 'Read back and confirmed: the description SAP holds matches what was requested.',
    });
  };
}
