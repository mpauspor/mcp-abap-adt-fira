/**
 * The failure policy is the part worth testing.
 *
 * The happy path was confirmed against a live system; what a unit test can do
 * that a live run cannot is force the case this whole mechanism exists for — a
 * write that reports success and changes nothing — and prove the wrapper
 * actually catches it rather than passing it through.
 */

import {
  METADATA_WRITE_TOOLS,
  withMetadataVerification,
} from '../../lib/metadataVerification';

type Result = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};

const ok = (payload: Record<string, unknown>): Result => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
});

/** A writer that claims success, as the unverified tools always did. */
const claimsSuccess = jest.fn(async () => ok({ success: true }));

const context = { connection: {}, logger: undefined } as any;

/** Swap in a reader so the test never touches a system. */
function stubReader(tool: string, responses: Result[]) {
  let call = 0;
  const descriptor = METADATA_WRITE_TOOLS[tool];
  const original = descriptor.read;
  descriptor.read = async () => async () =>
    responses[Math.min(call++, responses.length - 1)];
  return () => {
    descriptor.read = original;
  };
}

const parse = (result: Result) => JSON.parse(result.content[0].text);

describe('withMetadataVerification', () => {
  beforeEach(() => claimsSuccess.mockClear());

  it('passes a tool it does not cover straight through', async () => {
    const wrapped = withMetadataVerification(
      'UpdateProgram',
      claimsSuccess,
      () => context,
    );
    expect(wrapped).toBe(claimsSuccess);
  });

  it('confirms a description that reads back as requested', async () => {
    const restore = stubReader('UpdateDomain', [
      ok({ domain_data: '<doma adtcore:description="nuevo texto"/>' }),
    ]);
    try {
      const wrapped = withMetadataVerification(
        'UpdateDomain',
        claimsSuccess,
        () => context,
      );
      const result = await wrapped({
        domain_name: 'ZTEST',
        description: 'nuevo texto',
      });
      expect(result.isError).toBeFalsy();
      expect(parse(result).metadata_write_verified).toBe(true);
    } finally {
      restore();
    }
  });

  it('fails when the write did not land, however cheerful the handler', async () => {
    const restore = stubReader('UpdateDomain', [
      ok({ domain_data: '<doma adtcore:description="texto viejo"/>' }),
    ]);
    try {
      const wrapped = withMetadataVerification(
        'UpdateDomain',
        claimsSuccess,
        () => context,
      );
      const result = await wrapped({
        domain_name: 'ZTEST',
        description: 'nuevo texto',
      });
      expect(claimsSuccess).toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('texto viejo');
    } finally {
      restore();
    }
  });

  it('accepts a description SAP truncated to the field length', async () => {
    const restore = stubReader('UpdateDomain', [
      ok({ domain_data: '<doma adtcore:description="descripcion muy larg"/>' }),
    ]);
    try {
      const wrapped = withMetadataVerification(
        'UpdateDomain',
        claimsSuccess,
        () => context,
      );
      const result = await wrapped({
        domain_name: 'ZTEST',
        description: 'descripcion muy larga que SAP recorta',
      });
      expect(result.isError).toBeFalsy();
      const payload = parse(result);
      expect(payload.metadata_write_verified).toBe(true);
      expect(payload.metadata_verification_note).toContain('truncated');
    } finally {
      restore();
    }
  });

  it('reports unverified rather than failing when the read is unusable', async () => {
    const restore = stubReader('UpdateDomain', [ok({ nothing: 'useful' })]);
    try {
      const wrapped = withMetadataVerification(
        'UpdateDomain',
        claimsSuccess,
        () => context,
      );
      const result = await wrapped({
        domain_name: 'ZTEST',
        description: 'nuevo texto',
      });
      // A read problem is not a write problem.
      expect(result.isError).toBeFalsy();
      expect(parse(result).metadata_write_verified).toBe(false);
    } finally {
      restore();
    }
  });

  it('reads the inactive version too, so an unactivated write is not a failure', async () => {
    const restore = stubReader('UpdateDomain', [
      // Active still holds the old text; inactive has the new one.
      ok({ domain_data: '<doma adtcore:description="texto viejo"/>' }),
      ok({ domain_data: '<doma adtcore:description="nuevo texto"/>' }),
    ]);
    try {
      const wrapped = withMetadataVerification(
        'UpdateDomain',
        claimsSuccess,
        () => context,
      );
      const result = await wrapped({
        domain_name: 'ZTEST',
        description: 'nuevo texto',
        activate: false,
      });
      expect(result.isError).toBeFalsy();
      expect(parse(result).metadata_write_verified).toBe(true);
    } finally {
      restore();
    }
  });

  it('fails a service binding whose change timestamp never moved', async () => {
    const restore = stubReader('UpdateServiceBinding', [
      ok({ changedAt: '2020-01-01T00:00:00Z' }),
      ok({ changedAt: '2020-01-01T00:00:00Z' }),
    ]);
    try {
      const wrapped = withMetadataVerification(
        'UpdateServiceBinding',
        claimsSuccess,
        () => context,
      );
      const result = await wrapped({
        service_binding_name: 'ZTEST_SB',
        desired_publication_state: 'published',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('did not move');
    } finally {
      restore();
    }
  });

  it('confirms a service binding whose timestamp advanced', async () => {
    const restore = stubReader('UpdateServiceBinding', [
      ok({ changedAt: '2020-01-01T00:00:00Z' }),
      ok({ changedAt: '2026-08-21T09:00:00Z' }),
    ]);
    try {
      const wrapped = withMetadataVerification(
        'UpdateServiceBinding',
        claimsSuccess,
        () => context,
      );
      const result = await wrapped({
        service_binding_name: 'ZTEST_SB',
        desired_publication_state: 'published',
      });
      expect(result.isError).toBeFalsy();
      expect(parse(result).changed_at).toBe('2026-08-21T09:00:00Z');
    } finally {
      restore();
    }
  });

  it('does not claim verification when the caller supplied no description', async () => {
    const wrapped = withMetadataVerification(
      'UpdateDomain',
      claimsSuccess,
      () => context,
    );
    const result = await wrapped({ domain_name: 'ZTEST' });
    expect(result.isError).toBeFalsy();
    expect(parse(result).metadata_write_verified).toBe(false);
  });

  it('leaves a failing write alone instead of overwriting its error', async () => {
    const fails = jest.fn(async () => ({
      isError: true,
      content: [{ type: 'text', text: 'SAP rejected the update' }],
    }));
    const wrapped = withMetadataVerification(
      'UpdateDomain',
      fails as any,
      () => context,
    );
    const result = await wrapped({
      domain_name: 'ZTEST',
      description: 'nuevo texto',
    });
    expect(result.content[0].text).toBe('SAP rejected the update');
  });
});
