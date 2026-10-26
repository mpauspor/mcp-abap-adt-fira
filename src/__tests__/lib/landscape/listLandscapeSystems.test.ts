import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleListLandscapeSystems } from '../../../handlers/multisystem/readonly/handleListLandscapeSystems';
import * as probeModule from '../../../lib/landscape/probe';
import { unwrap } from '../../integration/helpers/firaContext';

describe('handleListLandscapeSystems', () => {
  let tempDir: string;
  let landscapeFile: string;
  const mockContext: any = {
    connection: {},
    logger: { error: jest.fn(), debug: jest.fn(), info: jest.fn() },
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-systems-test-'));
    landscapeFile = path.join(tempDir, 'SAPUILandscape.xml');

    // Create 12 services: 8 in Customer A, 4 in Customer B
    const itemsA = Array.from(
      { length: 8 },
      (_, i) => `<Item serviceid="uuid-a-${i}" />`,
    ).join('\n');
    const itemsB = Array.from(
      { length: 4 },
      (_, i) => `<Item serviceid="uuid-b-${i}" />`,
    ).join('\n');

    const servicesA = Array.from(
      { length: 8 },
      (_, i) =>
        `<Service uuid="uuid-a-${i}" name="System A${i}" systemid="SA${i}" server="host-a-${i}.corp:3200" type="SAPGUI" />`,
    ).join('\n');
    const servicesB = Array.from(
      { length: 4 },
      (_, i) =>
        `<Service uuid="uuid-b-${i}" name="System B${i}" systemid="SB${i}" server="host-b-${i}.corp:3200" type="SAPGUI" />`,
    ).join('\n');

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Landscape>
  <Workspaces>
    <Workspace name="Local">
      <Node name="Customer Alpha">
        ${itemsA}
      </Node>
      <Node name="Customer Beta">
        ${itemsB}
      </Node>
    </Workspace>
  </Workspaces>
  <Services>
    ${servicesA}
    ${servicesB}
  </Services>
</Landscape>`;

    fs.writeFileSync(landscapeFile, xml, 'utf8');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('lists all systems when no filter is provided', async () => {
    const res = await handleListLandscapeSystems(mockContext, {
      landscape_path: landscapeFile,
    });

    const { isError, payload } = unwrap(res);
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);
    expect(payload.count).toBe(12);
    expect(payload.systems.length).toBe(12);
    expect(payload.hint).toContain('SetupSystem');
  });

  it('filters systems by folder case-insensitively', async () => {
    const res = await handleListLandscapeSystems(mockContext, {
      landscape_path: landscapeFile,
      folder: 'beta',
    });

    const { isError, payload } = unwrap(res);
    expect(isError).toBe(false);
    expect(payload.count).toBe(4);
    expect(
      payload.systems.every((s: any) => s.name.startsWith('System B')),
    ).toBe(true);
  });

  it('rejects unexpected properties such as password', async () => {
    const res = await handleListLandscapeSystems(mockContext, {
      landscape_path: landscapeFile,
      password: 'secret',
    } as any);

    const { isError, payload } = unwrap(res);
    expect(isError).toBe(true);
    expect(payload).toMatch(/Unexpected property: password/);
  });

  it('fails before probing when probe: true and matches > probe_limit (default 10)', async () => {
    const probeSpy = jest
      .spyOn(probeModule, 'probeBatch')
      .mockResolvedValue(undefined);

    const res = await handleListLandscapeSystems(mockContext, {
      landscape_path: landscapeFile,
      probe: true,
    });

    const { isError, payload } = unwrap(res);
    expect(isError).toBe(true);
    expect(payload).toBe(
      '12 systems match; probing contacts each host. Narrow with folder= (limit 10).',
    );
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it('probes systems when probe: true and matches <= probe_limit', async () => {
    const probeSpy = jest
      .spyOn(probeModule, 'probeBatch')
      .mockResolvedValue(undefined);

    const res = await handleListLandscapeSystems(mockContext, {
      landscape_path: landscapeFile,
      folder: 'alpha', // 8 systems match <= 10 limit
      probe: true,
    });

    const { isError, payload } = unwrap(res);
    expect(isError).toBe(false);
    expect(payload.count).toBe(8);
    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(probeSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ name: expect.stringMatching(/System A/) }),
      ]),
      5,
      10000,
    );
  });

  it('respects custom probe_limit parameter', async () => {
    const probeSpy = jest
      .spyOn(probeModule, 'probeBatch')
      .mockResolvedValue(undefined);

    // 4 matches in Beta; with probe_limit: 3 it must fail before probing
    const res = await handleListLandscapeSystems(mockContext, {
      landscape_path: landscapeFile,
      folder: 'beta',
      probe: true,
      probe_limit: 3,
    });

    const { isError, payload } = unwrap(res);
    expect(isError).toBe(true);
    expect(payload).toBe(
      '4 systems match; probing contacts each host. Narrow with folder= (limit 3).',
    );
    expect(probeSpy).not.toHaveBeenCalled();
  });
});
