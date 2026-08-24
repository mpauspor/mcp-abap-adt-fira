/**
 * The fixture below is a trimmed capture of a real worklist, kept verbatim
 * because every bug this parser had came from the shape of the actual response
 * rather than from anything a schema would tell you.
 */

import {
  buildAtcObjectUri,
  parseAtcWorklist,
  summariseFindings,
} from '../../lib/adt/atc';

const WORKLIST = `<?xml version="1.0" encoding="utf-8"?>
<atcworklist:worklist xmlns:atcworklist="http://www.sap.com/adt/atc/worklist"
  atcworklist:id="F7A8" atcworklist:timestamp="2026-08-24T18:37:28Z"
  atcworklist:objectSetIsComplete="true">
 <atcworklist:objects>
  <atcobject:object xmlns:atcobject="http://www.sap.com/adt/atc/object"
    xmlns:adtcore="http://www.sap.com/adt/core"
    adtcore:uri="/sap/bc/adt/atc/objects/R3TR/PROG/SAPMZDEMO"
    adtcore:type="PROG" adtcore:name="SAPMZDEMO"
    adtcore:packageName="ZDEMO_PKG" atcobject:author="DEVUSER">
   <atcobject:findings>
    <atcfinding:finding xmlns:atcfinding="http://www.sap.com/adt/atc/finding"
      atcfinding:location="/sap/bc/adt/programs/includes/mzdemof01/source/main?context=%2fsap%2fbc%2fadt%2fprograms%2fprograms%2fsapmzdemo#start=809,0"
      atcfinding:priority="3" atcfinding:checkTitle="Search problematic statements"
      atcfinding:messageId="LOOP_EXIT" atcfinding:messageTitle="LOOP AT itab with &quot;EXIT&quot;"
      atcfinding:exemptionApproval="">
     <atcfinding:quickfixes atcfinding:manual="true" atcfinding:automatic="true" atcfinding:pseudo="true"/>
    </atcfinding:finding>
    <atcfinding:finding xmlns:atcfinding="http://www.sap.com/adt/atc/finding"
      atcfinding:location="/sap/bc/adt/programs/programs/sapmzdemo/source/main#start=124,0"
      atcfinding:priority="1" atcfinding:checkTitle="Extended Program Check (SLIN)"
      atcfinding:messageId="SLIN_X" atcfinding:messageTitle="Serious problem"
      atcfinding:exemptionApproval="X">
     <atcfinding:quickfixes atcfinding:manual="false" atcfinding:automatic="false" atcfinding:pseudo="false"/>
    </atcfinding:finding>
   </atcobject:findings>
  </atcobject:object>
 </atcworklist:objects>
</atcworklist:worklist>`;

describe('parseAtcWorklist', () => {
  const parsed = parseAtcWorklist(WORKLIST);

  it('counts only real objects', () => {
    // `<atcobject:findings>` used to be read as an object, inflating this.
    expect(parsed.objectsAnalysed).toBe(1);
    expect(parsed.findings).toHaveLength(2);
  });

  it('attributes each finding to the object that contains it', () => {
    // The same bug blanked these, since the bogus object tag reset the state.
    for (const finding of parsed.findings) {
      expect(finding.objectName).toBe('SAPMZDEMO');
      expect(finding.objectType).toBe('PROG');
      expect(finding.packageName).toBe('ZDEMO_PKG');
      expect(finding.author).toBe('DEVUSER');
    }
  });

  it('resolves the include a finding really sits in', () => {
    // `/programs/includes/mzdemof01/` contains two collection names, and
    // matching on collection names returned the wrong one.
    expect(parsed.findings[0].include).toBe('MZDEMOF01');
    expect(parsed.findings[0].line).toBe(809);
    expect(parsed.findings[1].include).toBe('SAPMZDEMO');
    expect(parsed.findings[1].line).toBe(124);
  });

  it('decodes entities in messages', () => {
    expect(parsed.findings[0].message).toBe('LOOP AT itab with "EXIT"');
  });

  it('reads the quickfix kinds and exemption state', () => {
    expect(parsed.findings[0].quickfix).toEqual({
      manual: true,
      automatic: true,
      pseudoComment: true,
    });
    expect(parsed.findings[0].exempted).toBe(false);
    expect(parsed.findings[1].exempted).toBe(true);
  });

  it('treats a truncated object set as incomplete', () => {
    expect(parsed.objectSetComplete).toBe(true);
    const truncated = parseAtcWorklist(
      WORKLIST.replace(
        'objectSetIsComplete="true"',
        'objectSetIsComplete="false"',
      ),
    );
    expect(truncated.objectSetComplete).toBe(false);
  });

  it('does not invent findings from an empty worklist', () => {
    const empty = parseAtcWorklist(
      '<atcworklist:worklist xmlns:atcworklist="x"><atcworklist:objects/></atcworklist:worklist>',
    );
    expect(empty.findings).toHaveLength(0);
    expect(empty.objectsAnalysed).toBe(0);
  });
});

describe('summariseFindings', () => {
  const { findings } = parseAtcWorklist(WORKLIST);
  const summary = summariseFindings(findings);

  it('leads with the worst priority', () => {
    expect(summary.total).toBe(2);
    expect(summary.by_priority).toEqual({ '1': 1, '3': 1 });
    expect(summary.top_checks[0].worst_priority).toBe(1);
  });

  it('counts what ATC could fix by itself', () => {
    expect(summary.fixable_automatically).toBe(1);
  });

  it('separates a check total from how many are at its worst priority', () => {
    // Reporting only the worst priority beside the total reads as though every
    // finding of that check were that severe.
    const slin = summary.top_checks.find((c) =>
      c.check.startsWith('Extended Program Check'),
    );
    expect(slin).toEqual({
      check: 'Extended Program Check (SLIN)',
      count: 1,
      worst_priority: 1,
      at_worst_priority: 1,
    });
  });
});

describe('buildAtcObjectUri', () => {
  it('encodes a namespaced package', () => {
    // A bare `$` is dropped by the URI mapper.
    expect(buildAtcObjectUri({ packageName: '$TMP' }).uri).toBe(
      '/sap/bc/adt/packages/%24tmp',
    );
  });

  it('builds an object URI from the type', () => {
    expect(
      buildAtcObjectUri({ objectName: 'ZFOO', objectType: 'CLAS/OC' }).uri,
    ).toBe('/sap/bc/adt/oo/classes/zfoo');
  });

  it('takes an explicit uri over everything else', () => {
    expect(
      buildAtcObjectUri({ uri: '/custom/path', packageName: 'ZSD' }).uri,
    ).toBe('/custom/path');
  });

  it('refuses when there is nothing to check', () => {
    expect(() => buildAtcObjectUri({})).toThrow(/Nothing to check/);
  });
});
