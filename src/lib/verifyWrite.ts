/**
 * Post-write verification for source-carrying ADT objects.
 *
 * ADT write handlers used to report `success: true` on the strength of "no
 * exception was thrown". That is not the same claim. A PUT can be answered
 * 200 while the source lands somewhere other than the object the caller named
 * — the observed case being an include updated through the *program* endpoint,
 * where lock, update and unlock all succeeded and nothing was written.
 *
 * Reading the source back and comparing it is the only thing that actually
 * substantiates the success claim, so every write path should end here.
 */

import type { ILogger } from '@mcp-abap-adt/interfaces';

export interface SourceVerification {
  /** True only when the object's source was read back and matches what was sent. */
  verified: boolean;
  /** Why verification did not succeed. Absent when `verified` is true. */
  reason?: string;
  expected_bytes: number;
  actual_bytes?: number;
}

/**
 * Normalise the incidental differences SAP introduces so that comparison
 * reports real divergence only.
 *
 * SAP rewrites line endings to LF, may strip trailing blanks from each line,
 * and does not preserve trailing empty lines. None of those are a failed
 * write, and treating them as one would make verification cry wolf on every
 * update — at which point it would be switched off and stop catching the
 * failures it exists for.
 */
function normalizeSource(source: string): string {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

/**
 * Read an object's source back and confirm it matches what was just written.
 *
 * A failure to READ is reported as unverified rather than thrown: the write
 * itself may well have succeeded, and turning a transient read problem into a
 * write failure would send callers chasing the wrong thing. The distinction is
 * carried in `reason`.
 *
 * @param readBack   Fetches the object's current source from SAP.
 * @param expected   The source that was sent.
 * @param objectLabel Used in log lines, e.g. `Include ZXY`.
 */
export async function verifySourceWritten(
  readBack: () => Promise<string>,
  expected: string,
  objectLabel: string,
  logger?: ILogger,
): Promise<SourceVerification> {
  const expectedBytes = expected.length;

  let actual: string;
  try {
    actual = await readBack();
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn(
      `${objectLabel}: could not read source back to verify the write: ${message}`,
    );
    return {
      verified: false,
      reason: `Could not read the object back to verify the write: ${message}. The update itself may or may not have been applied.`,
      expected_bytes: expectedBytes,
    };
  }

  if (typeof actual !== 'string') {
    return {
      verified: false,
      reason: 'Read-back returned no source text.',
      expected_bytes: expectedBytes,
    };
  }

  if (normalizeSource(actual) === normalizeSource(expected)) {
    logger?.debug(`${objectLabel}: write verified (${expectedBytes} bytes)`);
    return {
      verified: true,
      expected_bytes: expectedBytes,
      actual_bytes: actual.length,
    };
  }

  logger?.error(
    `${objectLabel}: write NOT verified — read-back differs (sent ${expectedBytes} bytes, read ${actual.length})`,
  );
  return {
    verified: false,
    reason:
      'The source read back from SAP does not match what was sent. The write was reported as successful but did not take effect on this object.',
    expected_bytes: expectedBytes,
    actual_bytes: actual.length,
  };
}
