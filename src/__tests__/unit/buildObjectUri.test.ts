/**
 * Unit tests for ADT object URI construction.
 *
 * These pin the three defects inherited from `@mcp-abap-adt/adt-clients`:
 * includes had no mapping at all, an unknown type silently produced an
 * invented path, and a function module fell back to using its own name as its
 * function group.
 */

import { buildObjectUri, isIncludeType } from '../../lib/adt/objectUri';

describe('buildObjectUri', () => {
  describe('includes', () => {
    it('maps PROG/I to the includes resource, not to programs', () => {
      expect(buildObjectUri({ name: 'ZXY_INCLUDE', type: 'PROG/I' })).toBe(
        '/sap/bc/adt/programs/includes/zxy_include',
      );
    });

    it('accepts the INCL alias', () => {
      expect(buildObjectUri({ name: 'ZXY_INCLUDE', type: 'INCL' })).toBe(
        '/sap/bc/adt/programs/includes/zxy_include',
      );
    });

    it('keeps PROG pointing at programs', () => {
      expect(buildObjectUri({ name: 'Z_REPORT', type: 'PROG/P' })).toBe(
        '/sap/bc/adt/programs/programs/z_report',
      );
    });

    it('recognises include type codes', () => {
      expect(isIncludeType('PROG/I')).toBe(true);
      expect(isIncludeType('prog/i')).toBe(true);
      expect(isIncludeType('PROG/P')).toBe(false);
      expect(isIncludeType(undefined)).toBe(false);
    });
  });

  describe('function modules', () => {
    it('nests the module under its function group', () => {
      expect(
        buildObjectUri({
          name: 'Z_MY_FM',
          type: 'FUGR/FF',
          parentName: 'Z_MY_GROUP',
        }),
      ).toBe('/sap/bc/adt/functions/groups/z_my_group/fmodules/z_my_fm');
    });

    it('refuses to guess the function group', () => {
      // The old fallback used the module's own name as the group, producing a
      // URI that looks right and 404s.
      expect(() =>
        buildObjectUri({ name: 'Z_MY_FM', type: 'FUGR/FF' }),
      ).toThrow(/function group is required/i);
    });
  });

  describe('explicit uri', () => {
    it('wins over the derived path', () => {
      expect(
        buildObjectUri({
          name: 'WHATEVER',
          type: 'PROG/P',
          uri: '/sap/bc/adt/custom/thing',
        }),
      ).toBe('/sap/bc/adt/custom/thing');
    });

    it('rescues a type the map does not know', () => {
      expect(
        buildObjectUri({ name: 'X', type: 'ZZZZ', uri: '/sap/bc/adt/z/x' }),
      ).toBe('/sap/bc/adt/z/x');
    });
  });

  describe('unknown input', () => {
    it('throws instead of inventing a path from the type code', () => {
      expect(() => buildObjectUri({ name: 'X', type: 'ZZZZ' })).toThrow(
        /Unknown object type/i,
      );
    });

    it('throws when no type is given', () => {
      expect(() => buildObjectUri({ name: 'X' })).toThrow(/no object type/i);
    });
  });

  describe('name handling', () => {
    it('lowercases the object name', () => {
      expect(buildObjectUri({ name: 'ZCL_MY_CLASS', type: 'CLAS/OC' })).toBe(
        '/sap/bc/adt/oo/classes/zcl_my_class',
      );
    });

    it('encodes namespaced names', () => {
      expect(buildObjectUri({ name: '/FOO/BAR', type: 'CLAS/OC' })).toBe(
        '/sap/bc/adt/oo/classes/%2ffoo%2fbar',
      );
    });
  });
});
