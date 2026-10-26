import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseLandscapeXml,
  readLandscapeFile,
} from '../../../lib/landscape/landscapeReader';

describe('landscapeReader', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'landscape-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('correctly parses nested folders and flattens them to folders array', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Landscape>
  <Workspaces>
    <Workspace name="Local">
      <Node name="Customer A">
        <Node name="S4">
          <Item serviceid="uuid-dev-1" />
        </Node>
      </Node>
    </Workspace>
  </Workspaces>
  <Services>
    <Service uuid="uuid-dev-1" name="S4 Development" systemid="DEV" server="s4dev.corp:3200" type="SAPGUI" />
  </Services>
</Landscape>`;

    const res = parseLandscapeXml(xml, path.join(tempDir, 'main.xml'));
    expect(res.services.size).toBe(1);
    expect(res.workspaces.length).toBe(1);
    expect(res.workspaces[0].items[0]).toEqual({
      serviceid: 'uuid-dev-1',
      folders: ['Customer A', 'S4'],
    });
  });

  it('collects multiple folder paths when a service is in multiple nodes', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Landscape>
  <Workspaces>
    <Workspace name="Local">
      <Node name="Folder 1">
        <Item serviceid="uuid-dev-1" />
      </Node>
      <Node name="Folder 2">
        <Item serviceid="uuid-dev-1" />
      </Node>
    </Workspace>
  </Workspaces>
  <Services>
    <Service uuid="uuid-dev-1" name="S4 Development" systemid="DEV" server="s4dev.corp:3200" type="SAPGUI" />
  </Services>
</Landscape>`;

    const filePath = path.join(tempDir, 'multi-node.xml');
    fs.writeFileSync(filePath, xml, 'utf8');

    const result = readLandscapeFile(filePath);
    expect(result.systems.length).toBe(1);
    expect(result.systems[0].folders).toEqual([['Folder 1'], ['Folder 2']]);
  });

  it('lists services not referenced by any item with folders: []', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Landscape>
  <Workspaces>
    <Workspace name="Local" />
  </Workspaces>
  <Services>
    <Service uuid="uuid-unreferenced" name="Unreferenced Service" systemid="UNR" server="unr.corp:3200" type="SAPGUI" />
  </Services>
</Landscape>`;

    const filePath = path.join(tempDir, 'unreferenced.xml');
    fs.writeFileSync(filePath, xml, 'utf8');

    const result = readLandscapeFile(filePath);
    expect(result.systems.length).toBe(1);
    expect(result.systems[0].service_uuid).toBe('uuid-unreferenced');
    expect(result.systems[0].folders).toEqual([]);
  });

  it('skips item referencing non-existent service and emits warning', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Landscape>
  <Workspaces>
    <Workspace name="Local">
      <Item serviceid="non-existent-uuid" />
    </Workspace>
  </Workspaces>
  <Services>
    <Service uuid="uuid-dev" name="DEV" systemid="DEV" server="s4dev.corp:3200" type="SAPGUI" />
  </Services>
</Landscape>`;

    const filePath = path.join(tempDir, 'missing-service.xml');
    fs.writeFileSync(filePath, xml, 'utf8');

    const result = readLandscapeFile(filePath);
    expect(result.systems.length).toBe(1);
    expect(result.warnings.some((w) => w.includes('non-existent-uuid'))).toBe(
      true,
    );
  });

  it('resolves relative and absolute file:/// includes and detects cycles without infinite loop', () => {
    const childXml = `<?xml version="1.0" encoding="utf-8"?>
<Landscape>
  <Includes>
    <Include url="file:///main.xml" />
  </Includes>
  <Services>
    <Service uuid="uuid-qas" name="QAS" systemid="QAS" server="s4qas.corp:3200" type="SAPGUI" />
  </Services>
</Landscape>`;

    const mainXml = `<?xml version="1.0" encoding="utf-8"?>
<Landscape>
  <Includes>
    <Include url="child.xml" />
  </Includes>
  <Services>
    <Service uuid="uuid-dev" name="DEV" systemid="DEV" server="s4dev.corp:3200" type="SAPGUI" />
  </Services>
</Landscape>`;

    const mainPath = path.join(tempDir, 'main.xml');
    const childPath = path.join(tempDir, 'child.xml');

    fs.writeFileSync(mainPath, mainXml, 'utf8');
    fs.writeFileSync(childPath, childXml, 'utf8');

    const result = readLandscapeFile(mainPath);
    expect(result.systems.length).toBe(2);
    expect(result.files_read.length).toBe(2);
  });

  it('stops recursion and adds warning when include depth exceeds 5', () => {
    let prevPath = '';
    for (let i = 0; i <= 6; i++) {
      const currentPath = path.join(tempDir, `file_${i}.xml`);
      const nextPath = path.join(tempDir, `file_${i + 1}.xml`);
      const includePart =
        i < 6 ? `<Includes><Include url="${nextPath}" /></Includes>` : '';
      const content = `<Landscape>${includePart}<Services><Service uuid="uuid-${i}" name="SYS_${i}" systemid="S${i}" server="host:3200" type="SAPGUI"/></Services></Landscape>`;
      fs.writeFileSync(currentPath, content, 'utf8');
      if (i === 0) prevPath = currentPath;
    }

    const result = readLandscapeFile(prevPath);
    expect(
      result.warnings.some((w) =>
        w.includes('Include depth limit (5) reached'),
      ),
    ).toBe(true);
  });

  it('gives precedence to including file on duplicate service uuid', () => {
    const childXml = `<Landscape><Services><Service uuid="uuid-1" name="Child Version" systemid="DEV" server="child:3200" type="SAPGUI"/></Services></Landscape>`;
    const mainXml = `<Landscape><Includes><Include url="child.xml"/></Includes><Services><Service uuid="uuid-1" name="Main Version" systemid="DEV" server="main:3200" type="SAPGUI"/></Services></Landscape>`;

    const mainPath = path.join(tempDir, 'main.xml');
    const childPath = path.join(tempDir, 'child.xml');
    fs.writeFileSync(mainPath, mainXml, 'utf8');
    fs.writeFileSync(childPath, childXml, 'utf8');

    const result = readLandscapeFile(mainPath);
    const service = result.systems.find((s) => s.service_uuid === 'uuid-1');
    expect(service?.name).toBe('Main Version');
    expect(service?.server).toBe('main:3200');
  });

  it('records HTTP(S) include in unresolved_includes without network calls', () => {
    const xml = `<Landscape><Includes><Include url="https://landscape.corp/shared.xml"/></Includes><Services/></Landscape>`;
    const filePath = path.join(tempDir, 'http-include.xml');
    fs.writeFileSync(filePath, xml, 'utf8');

    const result = readLandscapeFile(filePath);
    expect(result.unresolved_includes).toEqual([
      'https://landscape.corp/shared.xml',
    ]);
  });

  it('emits warning on missing include file and still returns other services', () => {
    const xml = `<Landscape><Includes><Include url="non-existent-child.xml"/></Includes><Services><Service uuid="uuid-1" name="Local Service" systemid="LOC" server="host:3200" type="SAPGUI"/></Services></Landscape>`;
    const filePath = path.join(tempDir, 'missing-include.xml');
    fs.writeFileSync(filePath, xml, 'utf8');

    const result = readLandscapeFile(filePath);
    expect(result.systems.length).toBe(1);
    expect(
      result.warnings.some((w) => w.includes('Included file not found')),
    ).toBe(true);
  });

  it('fails with actionable error when main landscape file is missing', () => {
    const nonExistent = path.join(tempDir, 'does-not-exist.xml');
    expect(() => readLandscapeFile(nonExistent)).toThrow(
      /No SAP Logon landscape at.*Pass landscape_path, or set SAP_LANDSCAPE_PATH/,
    );
  });

  it('derives ADT URL for real service shape carrying mode="1" without msid', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Landscape>
  <Workspaces>
    <Workspace name="Local">
      <Item serviceid="uuid-real-1" />
      <Item serviceid="uuid-ms-1" />
    </Workspace>
  </Workspaces>
  <Services>
    <Service uuid="uuid-real-1" name="Customer S4" systemid="S4D" mode="1" server="s4d.corp:3200" type="SAPGUI" />
    <Service uuid="uuid-ms-1" name="Customer Group" systemid="S4M" mode="1" msid="ms-uuid" type="SAPGUI" />
  </Services>
</Landscape>`;
    const filePath = path.join(tempDir, 'real-shape.xml');
    fs.writeFileSync(filePath, xml, 'utf8');

    const result = readLandscapeFile(filePath);
    const s4d = result.systems.find((s) => s.service_uuid === 'uuid-real-1');
    expect(s4d).toBeDefined();
    expect(s4d?.proposed_url).toBe('https://s4d.corp:44300');
    expect(s4d?.instance).toBe('00');
    expect(s4d?.url_source).toBe('derived');
    expect(s4d?.url_reason).toBeNull();

    const s4m = result.systems.find((s) => s.service_uuid === 'uuid-ms-1');
    expect(s4m).toBeDefined();
    expect(s4m?.proposed_url).toBeNull();
    expect(s4m?.url_reason).toBe('message_server');
  });

  it('fails with clean error when XML is malformed', () => {
    const filePath = path.join(tempDir, 'corrupt.xml');
    fs.writeFileSync(filePath, '<<<MALFORMED XML>>>', 'utf8');
    expect(() => readLandscapeFile(filePath)).toThrow(/Cannot parse/);
  });
});
