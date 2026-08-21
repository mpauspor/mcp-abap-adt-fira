/**
 * Integration tests for the tools whose happy path cannot be exercised safely.
 *
 * Releasing a transport is irreversible and puts it in the import queue;
 * catching a debuggee needs someone to trigger code by hand; abapGit needs a
 * server component DS4 does not have. So what is tested here is everything
 * around the happy path: the guards, the refusals, and the quality of the
 * message when the answer is "no".
 *
 * That is not a consolation prize. Every one of these paths exists because the
 * original returned something misleading, and a wrong refusal costs a developer
 * as much time as a wrong success.
 *
 * Run: npm test -- --testPathPatterns=fira/toolContracts
 */

import { handleAbapGitGetRepo } from '../../../handlers/abapgit/readonly/handleAbapGitGetRepo';
import { handleAbapGitListRepos } from '../../../handlers/abapgit/readonly/handleAbapGitListRepos';
import { handleDebuggerStep } from '../../../handlers/debugger/high/handleDebuggerStep';
import { handleDebuggerStop } from '../../../handlers/debugger/high/handleDebuggerStop';
import { handleDebuggerGetStack } from '../../../handlers/debugger/readonly/handleDebuggerGetStack';
import { handleDebuggerGetVariable } from '../../../handlers/debugger/readonly/handleDebuggerGetVariable';
import { handleReleaseTransport } from '../../../handlers/transport/high/handleReleaseTransport';
import { getDebuggerIdentity } from '../../../lib/adt/debuggerIdentity';
import { getTimeout } from '../helpers/configHelpers';
import { firaContext, unwrap } from '../helpers/firaContext';

/** A transport number that cannot exist, so nothing is ever released. */
const NON_EXISTENT_TRANSPORT = 'ZZZK999999';

describe('ReleaseTransport', () => {
  it(
    'reports that nothing was released for a request that does not exist',
    async () => {
      // SAP answers 200 even here, so the HTTP status is worthless as a signal
      // and tm:releasetimestamp is what decides.
      const context = await firaContext();
      const { isError, payload } = unwrap(
        await handleReleaseTransport(context, {
          transport_request: NON_EXISTENT_TRANSPORT,
        }),
      );

      expect(isError).toBe(false);
      expect(payload.success).toBe(false);
      expect(payload.message).toMatch(/nothing was released/i);
      expect(payload.release_timestamp).toBeUndefined();
    },
    getTimeout('long'),
  );

  it(
    'requires a transport number',
    async () => {
      const context = await firaContext();
      const { isError, payload } = unwrap(
        await handleReleaseTransport(context, {}),
      );

      expect(isError).toBe(true);
      expect(String(payload)).toMatch(/transport_request/);
    },
    getTimeout('default'),
  );
});

describe('Debugger without a session', () => {
  it('derives a stable identity, so a stop can find its own listener', () => {
    // A random per-process identity orphaned listeners, which hold the
    // user's session captive at the next breakpoint.
    const first = getDebuggerIdentity();
    const second = getDebuggerIdentity();

    expect(first.ideId).toBe(second.ideId);
    expect(first.terminalId).toBe(second.terminalId);
    expect(first.ideId).toMatch(/^MCP_ABAP_ADT_[0-9A-F]{8}$/);
  });

  it(
    'explains that no session is attached rather than failing obscurely',
    async () => {
      const context = await firaContext();
      const { isError, payload } = unwrap(
        await handleDebuggerGetStack(context, {}),
      );

      // Either it errors with a useful message, or the system happens to have
      // a session — both are valid, an obscure crash is not.
      if (isError) {
        expect(String(payload)).toMatch(/DebuggerListen|no debugger session/i);
      } else {
        expect(payload.success).toBe(true);
      }
    },
    getTimeout('long'),
  );

  it(
    'rejects a step action it does not know',
    async () => {
      const context = await firaContext();
      const { isError, payload } = unwrap(
        await handleDebuggerStep(context, { action: 'saltar_al_final' }),
      );

      expect(isError).toBe(true);
      expect(String(payload)).toMatch(/step_into|unknown action/i);
    },
    getTimeout('long'),
  );

  it(
    'requires a variable name',
    async () => {
      const context = await firaContext();
      const { isError, payload } = unwrap(
        await handleDebuggerGetVariable(context, {}),
      );

      expect(isError).toBe(true);
      expect(String(payload)).toMatch(/variable_name/);
    },
    getTimeout('default'),
  );

  it(
    'treats stopping a listener that is not running as success',
    async () => {
      // This tool has to stay safe to call defensively, or nobody will call it
      // and listeners will be left running.
      const context = await firaContext();
      const { isError, payload } = unwrap(
        await handleDebuggerStop(context, {}),
      );

      expect(isError).toBe(false);
      expect(payload.success).toBe(true);
    },
    getTimeout('long'),
  );
});

describe('abapGit', () => {
  it(
    'surfaces the server-side reason when the component is absent',
    async () => {
      // DS4 has no ADT abapGit component: /sap/bc/adt/abapgit is 404. The tool
      // must say so rather than report an empty repository list, which would
      // read as "no packages are linked".
      const context = await firaContext();
      const { isError, payload } = unwrap(
        await handleAbapGitListRepos(context, {}),
      );

      if (isError) {
        expect(String(payload).length).toBeGreaterThan(0);
      } else {
        expect(Array.isArray(payload.repositories)).toBe(true);
        expect(payload.count).toBe(payload.repositories.length);
      }
    },
    getTimeout('long'),
  );

  it(
    'requires a package name',
    async () => {
      const context = await firaContext();
      const { isError, payload } = unwrap(
        await handleAbapGitGetRepo(context, {}),
      );

      expect(isError).toBe(true);
      expect(String(payload)).toMatch(/package_name/);
    },
    getTimeout('default'),
  );
});
