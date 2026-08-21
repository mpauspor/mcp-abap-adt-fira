/**
 * Integration tests for the cross-system comparison tools.
 *
 * These run against the real landscape. The assertions deliberately avoid
 * pinning the CONTENT of any comparison — whether ZSD is in sync with QAS today
 * is a fact about Fira's transports, not about this code, and a test that
 * asserts it would go red every time someone releases something.
 *
 * What is asserted is the contract: that a verdict is one of the known values,
 * that absence is reported as absence rather than as an error, that an
 * unreachable system fails loudly, and that identical input yields `identical`.
 *
 * Run: npm test -- --testPathPatterns=fira/multisystem
 */

import { handleCompareObjectAcrossSystems } from '../../../handlers/multisystem/readonly/handleCompareObjectAcrossSystems';
import { handleComparePackageAcrossLandscape } from '../../../handlers/multisystem/readonly/handleComparePackageAcrossLandscape';
import { handleComparePackageAcrossSystems } from '../../../handlers/multisystem/readonly/handleComparePackageAcrossSystems';
import { handleListSystems } from '../../../handlers/multisystem/readonly/handleListSystems';
import { getTimeout } from '../helpers/configHelpers';
import {
  comparisonPackage,
  configuredComparisonSystem,
  firaContext,
  unwrap,
} from '../helpers/firaContext';

const target = configuredComparisonSystem();
const pkg = comparisonPackage();

/** A class every ABAP system has, so the test needs no fixture. */
const STANDARD_CLASS = 'CL_ABAP_TYPEDESCR';

const describeCrossSystem = target ? describe : describe.skip;

describe('ListSystems', () => {
  it(
    'reports the current system with its URL',
    async () => {
      const context = await firaContext();
      const { isError, payload } = unwrap(await handleListSystems(context, {}));

      expect(isError).toBe(false);
      expect(payload.success).toBe(true);

      // Regression: this read process.env, which --env-path does not fully
      // populate, so the current system came back without a URL while every
      // secondary system had one.
      expect(typeof payload.current_system?.url).toBe('string');
      expect(payload.current_system.url.length).toBeGreaterThan(0);
      expect(Array.isArray(payload.comparison_systems)).toBe(true);
    },
    getTimeout('default'),
  );

  it(
    'never exposes a credential',
    async () => {
      const context = await firaContext();
      const { payload } = unwrap(await handleListSystems(context, {}));

      const serialised = JSON.stringify(payload).toLowerCase();
      expect(serialised).not.toContain('password');
      for (const system of payload.comparison_systems ?? []) {
        expect(typeof system.has_credentials).toBe('boolean');
        expect(system).not.toHaveProperty('SAP_PASSWORD');
      }
    },
    getTimeout('default'),
  );
});

describe('CompareObjectAcrossSystems — contract', () => {
  it(
    'names the available systems when asked for an unknown one',
    async () => {
      const context = await firaContext();
      const { isError, payload } = unwrap(
        await handleCompareObjectAcrossSystems(context, {
          object_name: STANDARD_CLASS,
          object_type: 'CLAS/OC',
          target_system: 'sistema-que-no-existe',
        }),
      );

      expect(isError).toBe(true);
      expect(String(payload)).toMatch(/unknown system/i);
      // The message must say where a definition was expected, or the caller
      // has no way to create one.
      expect(String(payload)).toMatch(/\.env/);
    },
    getTimeout('default'),
  );

  it(
    'refuses an object type it cannot address instead of guessing a URL',
    async () => {
      const context = await firaContext();
      const { isError, payload } = unwrap(
        await handleCompareObjectAcrossSystems(context, {
          object_name: 'CUALQUIERA',
          object_type: 'TIPO_INVENTADO',
          target_system: target ?? 'qs4',
        }),
      );

      expect(isError).toBe(true);
      expect(String(payload)).toMatch(/unknown object type/i);
    },
    getTimeout('default'),
  );
});

describeCrossSystem(`CompareObjectAcrossSystems — against ${target}`, () => {
  it(
    'reports a standard SAP class consistently',
    async () => {
      const context = await firaContext();
      const { isError, payload } = unwrap(
        await handleCompareObjectAcrossSystems(context, {
          object_name: STANDARD_CLASS,
          object_type: 'CLAS/OC',
          target_system: target as string,
          include_diff: false,
        }),
      );

      expect(isError).toBe(false);
      expect(['identical', 'different']).toContain(payload.verdict);
      expect(payload.source_status).toBe('present');
      expect(payload.target_status).toBe('present');
      // A class present in both must report a size for both.
      expect(payload.source_bytes).toBeGreaterThan(0);
      expect(payload.target_bytes).toBeGreaterThan(0);
    },
    getTimeout('long'),
  );

  it(
    'treats an object missing everywhere as a result, not an error',
    async () => {
      const context = await firaContext();
      const { isError, payload } = unwrap(
        await handleCompareObjectAcrossSystems(context, {
          object_name: 'ZZ_NO_EXISTE_EN_NINGUN_SITIO',
          object_type: 'CLAS/OC',
          target_system: target as string,
        }),
      );

      expect(isError).toBe(false);
      expect(payload.verdict).toBe('missing_in_both');
    },
    getTimeout('long'),
  );

  it(
    'produces a diff only when the sources differ',
    async () => {
      const context = await firaContext();
      const { payload } = unwrap(
        await handleCompareObjectAcrossSystems(context, {
          object_name: STANDARD_CLASS,
          object_type: 'CLAS/OC',
          target_system: target as string,
          include_diff: true,
        }),
      );

      if (payload.verdict === 'identical') {
        expect(payload.diff).toBeUndefined();
      } else {
        expect(typeof payload.diff).toBe('string');
        expect(payload.diff).toContain('@@');
      }
    },
    getTimeout('long'),
  );
});

describeCrossSystem(`ComparePackageAcrossSystems — ${pkg}`, () => {
  it(
    'expands function groups instead of skipping them',
    async () => {
      const context = await firaContext();
      const { isError, payload } = unwrap(
        await handleComparePackageAcrossSystems(context, {
          package_name: pkg,
          target_system: target as string,
          max_objects: 12,
        }),
      );

      expect(isError).toBe(false);
      expect(payload.units_compared).toBeGreaterThan(0);

      // Regression: a FUGR has no /source/main of its own. Before it was
      // expanded, a package of function groups compared zero units.
      const verdicts = Object.keys(payload.summary ?? {});
      expect(verdicts.length).toBeGreaterThan(0);
      for (const verdict of verdicts) {
        expect([
          'identical',
          'different',
          'only_in_source',
          'only_in_target',
          'unreadable',
        ]).toContain(verdict);
      }
    },
    getTimeout('long'),
  );

  it(
    'never silently drops objects it did not compare',
    async () => {
      const context = await firaContext();
      const { payload } = unwrap(
        await handleComparePackageAcrossSystems(context, {
          package_name: pkg,
          target_system: target as string,
          max_objects: 5,
        }),
      );

      // Anything left out is accounted for, either as not comparable or as
      // over the cap. Silence here would read as "everything is in sync".
      expect(payload.units_compared).toBeLessThanOrEqual(5);
      expect(
        payload.skipped_over_cap !== undefined ||
          payload.not_comparable !== undefined ||
          payload.units_compared === payload.objects_in_package,
      ).toBe(true);
    },
    getTimeout('long'),
  );
});

describeCrossSystem('ComparePackageAcrossLandscape', () => {
  it(
    'rejects an empty chain with a pointer to ListSystems',
    async () => {
      const context = await firaContext();
      const { isError, payload } = unwrap(
        await handleComparePackageAcrossLandscape(context, {
          package_name: pkg,
          systems: [],
        }),
      );

      expect(isError).toBe(true);
      expect(String(payload)).toMatch(/ListSystems/);
    },
    getTimeout('default'),
  );

  it(
    'classifies every unit into a known promotion state',
    async () => {
      const context = await firaContext();
      const { isError, payload } = unwrap(
        await handleComparePackageAcrossLandscape(context, {
          package_name: pkg,
          systems: [target as string],
          max_objects: 12,
          only_pending: false,
        }),
      );

      expect(isError).toBe(false);
      expect(payload.chain).toEqual([target]);
      expect(payload.objects.length).toBe(payload.units_compared);

      for (const row of payload.objects) {
        expect([
          'promoted',
          'pending',
          'not_transported',
          'out_of_band',
          'unreadable',
        ]).toContain(row.status);
        // Every target in the chain gets a verdict; a missing one would make
        // "promoted" mean "we did not look".
        expect(Object.keys(row.per_system)).toEqual([target]);
      }
    },
    getTimeout('long'),
  );

  it(
    'reports a promoted object as having reached the end of the chain',
    async () => {
      const context = await firaContext();
      const { payload } = unwrap(
        await handleComparePackageAcrossLandscape(context, {
          package_name: pkg,
          systems: [target as string],
          max_objects: 12,
          only_pending: false,
        }),
      );

      for (const row of payload.objects) {
        if (row.status === 'promoted') {
          expect(row.pending_from).toBeNull();
          expect(row.reached_through).toBe(target);
        }
        if (row.status === 'pending') {
          expect(row.pending_from).not.toBeNull();
        }
      }
    },
    getTimeout('long'),
  );
});
