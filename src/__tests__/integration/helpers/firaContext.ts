/**
 * Lightweight context for the Fira-specific integration tests.
 *
 * The repository's `LambdaTester` drives each test from a per-case block in
 * `test-config.yaml`, which is the right shape for the object-lifecycle suites
 * it was built for. The tools added in this fork are mostly read-only and take
 * their inputs from the landscape rather than from fixtures, so they only need
 * a connection — wiring fifteen more config blocks would add ceremony without
 * adding coverage.
 *
 * This uses the same config and env loading as the rest of the suite, so a
 * single `test-config.yaml` still drives everything.
 */

import { createAbapConnection } from '@mcp-abap-adt/connection';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces';
import type { HandlerContext } from '../../../lib/handlers/interfaces';
import {
  getSapConfigFromEnv,
  loadTestConfig,
  loadTestEnv,
} from './configHelpers';

let connection: IAbapConnection | undefined;

/** Connect to the system under test, reusing one connection per run. */
export async function firaContext(): Promise<HandlerContext> {
  if (!connection) {
    await loadTestEnv();
    connection = createAbapConnection(
      getSapConfigFromEnv(),
      undefined,
      'mcp-abap-adt-fira-tests',
    );
  }
  return { connection };
}

/** Unwrap an MCP tool result into something a test can assert against. */
export function unwrap(result: any): { isError: boolean; payload: any } {
  const text = result?.content?.[0]?.text ?? '';
  let payload: any = text;
  try {
    payload = JSON.parse(text);
  } catch {
    /* plain-text result, e.g. raw source */
  }
  return { isError: result?.isError === true, payload };
}

/**
 * Names of comparison systems defined for this machine.
 *
 * The cross-system tests are skipped rather than failed when none exist: a
 * developer running the suite without a QAS definition has not broken
 * anything, and a red suite for a missing local file trains people to ignore
 * red suites.
 */
export function configuredComparisonSystem(): string | undefined {
  const configured = loadTestConfig()?.fira?.comparison_system;
  if (typeof configured === 'string' && configured) return configured;
  return undefined;
}

/** Package used by the read-only package sweeps. */
export function comparisonPackage(): string {
  return loadTestConfig()?.fira?.comparison_package ?? 'ZSD';
}
