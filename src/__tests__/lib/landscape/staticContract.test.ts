import * as fs from 'node:fs';
import * as path from 'node:path';
import { TOOL_DEFINITION as SetupSystem_Tool } from '../../../handlers/multisystem/high/handleSetupSystem';
import { TOOL_DEFINITION as ListLandscapeSystems_Tool } from '../../../handlers/multisystem/readonly/handleListLandscapeSystems';
import { HighLevelHandlersGroup } from '../../../lib/handlers/groups/HighLevelHandlersGroup';
import { ReadOnlyHandlersGroup } from '../../../lib/handlers/groups/ReadOnlyHandlersGroup';

describe('Static contracts for multisystem & landscape tools', () => {
  it('does not import McpError anywhere in src/handlers/multisystem', () => {
    const multisystemDir = path.resolve(
      __dirname,
      '../../../handlers/multisystem',
    );
    function scanDir(dir: string): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...scanDir(full));
        } else if (entry.isFile() && full.endsWith('.ts')) {
          files.push(full);
        }
      }
      return files;
    }

    const files = scanDir(multisystemDir);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content).not.toMatch(/from\s+['"][^'"]*McpError[^'"]*['"]/);
      expect(content).not.toMatch(/new\s+McpError\s*\(/);
    }
  });

  it('exposes TOOL_DEFINITION on ListLandscapeSystems and SetupSystem', () => {
    expect(ListLandscapeSystems_Tool).toBeDefined();
    expect(ListLandscapeSystems_Tool.name).toBe('ListLandscapeSystems');
    expect(ListLandscapeSystems_Tool.inputSchema).toBeDefined();
    // available_in should be omitted as these tools do not depend on active system type
    expect((ListLandscapeSystems_Tool as any).available_in).toBeUndefined();
    expect(
      (ListLandscapeSystems_Tool.inputSchema as any).additionalProperties,
    ).toBe(false);
    expect(ListLandscapeSystems_Tool.inputSchema.properties).toHaveProperty(
      'folder',
    );
    expect(ListLandscapeSystems_Tool.inputSchema.properties).toHaveProperty(
      'probe_limit',
    );
    expect(ListLandscapeSystems_Tool.inputSchema.properties).not.toHaveProperty(
      'budget_ms',
    );
    expect(ListLandscapeSystems_Tool.inputSchema.properties).not.toHaveProperty(
      'timeout_ms',
    );

    expect(SetupSystem_Tool).toBeDefined();
    expect(SetupSystem_Tool.name).toBe('SetupSystem');
    expect(SetupSystem_Tool.inputSchema).toBeDefined();
    // available_in should be omitted as these tools do not depend on active system type
    expect((SetupSystem_Tool as any).available_in).toBeUndefined();
    expect((SetupSystem_Tool.inputSchema as any).additionalProperties).toBe(
      false,
    );
  });

  it('registers ListLandscapeSystems in ReadOnlyHandlersGroup', () => {
    const mockContext: any = { connection: {}, logger: {} };
    const group = new ReadOnlyHandlersGroup(mockContext);
    const handlers = group.getHandlers();
    const found = handlers.find(
      (t) => t.toolDefinition.name === 'ListLandscapeSystems',
    );
    expect(found).toBeDefined();
  });

  it('registers SetupSystem in HighLevelHandlersGroup', () => {
    const mockContext: any = { connection: {}, logger: {} };
    const group = new HighLevelHandlersGroup(mockContext);
    const handlers = group.getHandlers();
    const found = handlers.find((t) => t.toolDefinition.name === 'SetupSystem');
    expect(found).toBeDefined();
  });

  it('does not contain "cmdkey /list" anywhere in src/ (outside test files)', () => {
    const srcDir = path.resolve(__dirname, '../../..');
    function scanDir(dir: string): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') {
            files.push(...scanDir(full));
          }
        } else if (entry.isFile() && full.endsWith('.ts')) {
          files.push(full);
        }
      }
      return files;
    }

    const files = scanDir(srcDir);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content).not.toMatch(/cmdkey\s+\/list/i);
    }
  });

  it('no TOOL_DEFINITION inputSchema in src/ declares a property named "password"', () => {
    const handlersDir = path.resolve(__dirname, '../../../handlers');
    function scanDir(dir: string): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...scanDir(full));
        } else if (entry.isFile() && full.endsWith('.ts')) {
          files.push(full);
        }
      }
      return files;
    }

    const files = scanDir(handlersDir);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('TOOL_DEFINITION')) {
        try {
          const mod = require(file);
          if (mod.TOOL_DEFINITION?.inputSchema?.properties) {
            const propKeys = Object.keys(
              mod.TOOL_DEFINITION.inputSchema.properties,
            );
            expect(propKeys).not.toContain('password');
          }
        } catch {
          // If require fails, check schema properties with regex
          const schemaMatch = content.match(
            /inputSchema:\s*\{[\s\S]*?\n\s*\},/,
          );
          if (schemaMatch) {
            expect(schemaMatch[0]).not.toMatch(/\bpassword\s*:/);
          }
        }
      }
    }
  });
});
