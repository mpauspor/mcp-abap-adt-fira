/**
 * Moving source in and out of the conversation via local files.
 *
 * The MCP call itself is the size ceiling: a 165 KB report (measured; such
 * one real report was exactly that) cannot be passed as a tool argument, and reading one back
 * consumes an enormous share of the context window for text nobody wants to
 * read inline.
 *
 * The server runs on the user's own machine, so it can simply touch the
 * filesystem: `source_path` on a write reads the file directly, and `to_file` on
 * a read writes the output straight to disk. Neither the code nor the payload
 * ever passes through the model.
 *
 * Both are opt-in. A call that omits them behaves exactly as before.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Beyond this a "source file" is almost certainly a mistake, not a program. */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

/**
 * Read ABAP source from a local file.
 *
 * Strips a UTF-8 BOM. Windows editors add one routinely, and a BOM in front of
 * `REPORT ...` is not whitespace to the ABAP compiler — it produces a syntax
 * error whose cause is invisible in the editor that created it.
 */
export function readSourceFile(filePath: string): string {
  const resolved = path.resolve(filePath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`source_path not found: ${resolved}`);
  }
  if (!stat.isFile()) {
    throw new Error(`source_path is not a file: ${resolved}`);
  }
  if (stat.size > MAX_SOURCE_BYTES) {
    throw new Error(
      `source_path is ${Math.round(stat.size / 1024)} KB, above the ${Math.round(MAX_SOURCE_BYTES / 1024)} KB limit: ${resolved}`,
    );
  }

  const text = fs.readFileSync(resolved, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export interface FileWriteResult {
  path: string;
  bytes: number;
  lines: number;
}

/**
 * Write a tool's output to a local file.
 *
 * Refuses to overwrite unless asked. A path typo that silently replaces
 * something the user cared about is a worse outcome than one extra parameter,
 * and the refusal names the file and its size so the decision is informed.
 */
export function writeOutputFile(
  filePath: string,
  content: string,
  overwrite: boolean,
): FileWriteResult {
  const resolved = path.resolve(filePath);

  if (fs.existsSync(resolved) && !overwrite) {
    const existing = fs.statSync(resolved);
    throw new Error(
      `${resolved} already exists (${existing.size} bytes). Pass overwrite=true to replace it, or choose another path.`,
    );
  }

  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(resolved, content, 'utf8');

  return {
    path: resolved,
    bytes: Buffer.byteLength(content, 'utf8'),
    lines: content.length === 0 ? 0 : content.split('\n').length,
  };
}

/** Add `source_path` alongside a tool's existing source argument. */
export function addSourcePathToSchema(schema: any, sourceArg: string): any {
  if (!schema?.properties || schema.properties.source_path) return schema;

  return {
    ...schema,
    properties: {
      ...schema.properties,
      source_path: {
        type: 'string',
        description: `Absolute path to a local file holding the source. Use INSTEAD OF ${sourceArg} for large objects — the file is read directly by the server, so it is not limited by the size of a tool call.`,
      },
    },
    // The source argument stops being mandatory once a file can supply it.
    required: Array.isArray(schema.required)
      ? schema.required.filter((name: string) => name !== sourceArg)
      : schema.required,
  };
}

/**
 * Whether a tool should offer `to_file`.
 *
 * Restricted to the verbs that can return something large. Adding two schema
 * properties to all 223 tools would cost context on every single request to buy
 * an option nobody would use on, say, a delete.
 */
export function shouldOfferOutputFile(toolName: string): boolean {
  return /^(Get|Read|List|Search|Compare|Describe|Runtime)/.test(toolName);
}

/** Add `to_file` / `overwrite` to a read tool. */
export function addOutputFileToSchema(schema: any): any {
  const base = schema?.properties ? schema : { type: 'object', properties: {} };
  if (base.properties.to_file) return base;

  return {
    ...base,
    properties: {
      ...base.properties,
      to_file: {
        type: 'string',
        description:
          "Absolute path to write this tool's output to instead of returning it. Use for large sources and result sets — the content goes straight to disk and only a summary comes back.",
      },
      overwrite: {
        type: 'boolean',
        description:
          'Allow to_file to replace an existing file. Default false.',
      },
    },
  };
}

/**
 * Field names the Get* handlers use for "the source". There is no single
 * convention — GetProgram says program_data, GetClass says source_code, GetDdl
 * says source, GetInterface says interface_data — so the round trip
 * (read to file, edit, write back) needs this map to produce an editable .abap
 * file rather than a JSON envelope with the code escaped inside it.
 */
const SOURCE_FIELDS = [
  'source_code',
  'source',
  'program_data',
  'class_data',
  'interface_data',
  'ddl_source',
  'include_data',
  'code',
];

/**
 * Pull the bare source out of a tool payload, when there is one.
 *
 * Returns undefined for anything else — a result set, a comparison, a status —
 * which is then written whole. The caller is always told which happened.
 */
function extractSource(text: string): string | undefined {
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    // Not JSON: the handler already returned bare source (GetInclude does).
    return undefined;
  }
  if (!payload || typeof payload !== 'object') return undefined;

  for (const field of SOURCE_FIELDS) {
    const value = payload[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * Let a write handler take its source from a file.
 *
 * Rejects being given both a file and inline source rather than silently
 * picking one — which of the two the caller meant is not inferable, and
 * guessing wrong writes the wrong code into SAP.
 */
export function withSourceFromFile<H extends (...args: any[]) => any>(
  sourceArg: string,
  handler: H,
): (...args: Parameters<H>) => Promise<Awaited<ReturnType<H>>> {
  return async (...callArgs: Parameters<H>) => {
    const args: any = callArgs[callArgs.length - 1];
    const sourcePath = args?.source_path;

    if (typeof sourcePath === 'string' && sourcePath.trim()) {
      if (typeof args[sourceArg] === 'string' && args[sourceArg].length > 0) {
        return errorResult(
          `Both source_path and ${sourceArg} were given. Pass only one — the file, or the inline source.`,
        ) as any;
      }
      try {
        args[sourceArg] = readSourceFile(sourcePath.trim());
      } catch (error: any) {
        return errorResult(error?.message || String(error)) as any;
      }
    }

    return handler(...callArgs);
  };
}

/** Let any read handler divert its output to a file. */
export function withOutputToFile<H extends (...args: any[]) => any>(
  handler: H,
): (...args: Parameters<H>) => Promise<Awaited<ReturnType<H>>> {
  return async (...callArgs: Parameters<H>) => {
    const args: any = callArgs[callArgs.length - 1];
    const target = args?.to_file;

    const result: any = await handler(...callArgs);

    if (typeof target !== 'string' || !target.trim()) return result;
    // A failed call has no output worth saving, and writing the error text to
    // the caller's file would be a surprising place to find it.
    if (result?.isError) return result;

    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string') return result;

    try {
      const source = extractSource(text);
      const written = writeOutputFile(
        target.trim(),
        source ?? text,
        args?.overwrite === true,
      );
      return {
        isError: false,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                written_to: written.path,
                bytes: written.bytes,
                lines: written.lines,
                content: source ? 'source' : 'full tool output',
                message: source
                  ? `Source written to ${written.path} (${written.bytes} bytes, ${written.lines} lines). Edit it there and pass the same path as source_path to write it back.`
                  : `Full tool output written to ${written.path} (${written.bytes} bytes, ${written.lines} lines). It was not returned inline.`,
              },
              null,
              2,
            ),
          },
        ],
      } as any;
    } catch (error: any) {
      return errorResult(error?.message || String(error)) as any;
    }
  };
}
