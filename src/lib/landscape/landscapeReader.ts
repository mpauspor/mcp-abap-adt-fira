import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { listAvailableSystems } from '../adt/secondarySystem';
import { deriveAdtUrl, parseServer } from './adtUrl';
import type {
  LandscapeParseResult,
  LandscapeSystem,
  LandscapeSystemSession,
} from './types';

export function getDefaultLandscapePath(): string {
  if (process.env.SAP_LANDSCAPE_PATH) {
    return process.env.SAP_LANDSCAPE_PATH;
  }
  const appData =
    process.env.APPDATA ||
    path.join(
      process.env.USERPROFILE || process.env.HOME || '',
      'AppData',
      'Roaming',
    );
  return path.join(appData, 'SAP', 'Common', 'SAPUILandscape.xml');
}

function resolveFileUrl(
  includeUrl: string,
  baseDir: string,
): { localPath?: string; isRemote?: boolean } {
  const trimmed = includeUrl.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return { isRemote: true };
  }
  if (trimmed.startsWith('file://')) {
    try {
      return { localPath: url.fileURLToPath(trimmed) };
    } catch {
      const clean = trimmed.replace(/^file:\/\/\/?/i, '');
      return { localPath: path.resolve(baseDir, clean) };
    }
  }
  return { localPath: path.resolve(baseDir, trimmed) };
}

interface RawLandscapeData {
  services: Map<string, any>;
  workspaces: Array<{
    name: string;
    items: Array<{ serviceid: string; folders: string[] }>;
  }>;
  warnings: string[];
  unresolvedIncludes: string[];
  filesRead: string[];
}

export function parseLandscapeXml(
  xmlContent: string,
  currentFilePath: string,
  visitedFiles: Set<string> = new Set(),
  depth = 0,
): RawLandscapeData {
  const normalizedCurrent = path.normalize(path.resolve(currentFilePath));
  visitedFiles.add(normalizedCurrent);

  const validation = XMLValidator.validate(xmlContent);
  if (validation !== true) {
    const msg =
      typeof validation === 'object' && validation.err
        ? validation.err.msg
        : 'Malformed XML';
    throw new Error(`Cannot parse XML: ${msg}`);
  }

  const services = new Map<string, any>();
  const workspaces: RawLandscapeData['workspaces'] = [];
  const warnings: string[] = [];
  const unresolvedIncludes: string[] = [];
  const filesRead: string[] = [normalizedCurrent];

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
    isArray: (name) =>
      [
        'Workspace',
        'Node',
        'Item',
        'Service',
        'Include',
        'Router',
        'Messageserver',
      ].includes(name),
  });

  const parsed = parser.parse(xmlContent);
  const root =
    parsed.Landscape || parsed.SAPUILandscape || parsed.LandscapeData || parsed;

  // 1. Parse Services
  const rawServices: any[] = root.Services?.Service || [];
  for (const s of rawServices) {
    const uuid = s['@_uuid'];
    if (!uuid) continue;
    const type = s['@_type'];
    if (type && type !== 'SAPGUI') {
      warnings.push(
        `Service "${s['@_name'] || uuid}" has unsupported type "${type}" (only SAPGUI supported).`,
      );
      continue;
    }
    services.set(uuid, s);
  }

  // 2. Parse Workspaces, Nodes, and Items
  const rawWorkspaces: any[] = root.Workspaces?.Workspace || [];
  for (const ws of rawWorkspaces) {
    const wsName = ws['@_name'] || 'Local';
    const items: Array<{ serviceid: string; folders: string[] }> = [];

    function traverseNodes(nodeContainer: any, currentFolder: string[]) {
      const nodes: any[] = nodeContainer.Node || [];
      for (const node of nodes) {
        const folderName = node['@_name'] || '';
        const nextFolder = folderName
          ? [...currentFolder, folderName]
          : currentFolder;

        const nodeItems: any[] = node.Item || [];
        for (const item of nodeItems) {
          const serviceid = item['@_serviceid'];
          if (serviceid) {
            items.push({ serviceid, folders: nextFolder });
          }
        }
        traverseNodes(node, nextFolder);
      }
    }

    const directItems: any[] = ws.Item || [];
    for (const item of directItems) {
      const serviceid = item['@_serviceid'];
      if (serviceid) {
        items.push({ serviceid, folders: [] });
      }
    }

    traverseNodes(ws, []);
    workspaces.push({ name: wsName, items });
  }

  // 3. Follow Includes
  const rawIncludes: any[] = root.Includes?.Include || [];
  const baseDir = path.dirname(normalizedCurrent);

  for (const inc of rawIncludes) {
    const incUrl = inc['@_url'];
    if (!incUrl) continue;

    const resolved = resolveFileUrl(incUrl, baseDir);
    if (resolved.isRemote) {
      unresolvedIncludes.push(incUrl);
      continue;
    }

    const localPath = resolved.localPath;
    if (!localPath) {
      warnings.push(`Cannot resolve include URL: ${incUrl}`);
      continue;
    }

    const normalizedIncPath = path.normalize(path.resolve(localPath));
    if (visitedFiles.has(normalizedIncPath)) {
      continue; // cycle guard
    }

    if (depth >= 5) {
      warnings.push(`Include depth limit (5) reached at: ${normalizedIncPath}`);
      continue;
    }

    if (!fs.existsSync(normalizedIncPath)) {
      warnings.push(`Included file not found: ${normalizedIncPath}`);
      continue;
    }

    try {
      const childContent = fs.readFileSync(normalizedIncPath, 'utf8');
      const childData = parseLandscapeXml(
        childContent,
        normalizedIncPath,
        visitedFiles,
        depth + 1,
      );

      filesRead.push(...childData.filesRead);
      warnings.push(...childData.warnings);
      unresolvedIncludes.push(...childData.unresolvedIncludes);

      // Merge services: including file wins when uuid is duplicated
      for (const [uuid, svc] of childData.services.entries()) {
        if (!services.has(uuid)) {
          services.set(uuid, svc);
        }
      }

      // Merge workspaces
      workspaces.push(...childData.workspaces);
    } catch (err: any) {
      warnings.push(
        `Failed to read included file ${normalizedIncPath}: ${err.message}`,
      );
    }
  }

  return {
    services,
    workspaces,
    warnings,
    unresolvedIncludes,
    filesRead,
  };
}

/**
 * Load and parse the SAP landscape file from disk.
 */
export function readLandscapeFile(
  landscapePath?: string,
): LandscapeParseResult {
  const filePath = path.resolve(landscapePath || getDefaultLandscapePath());
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `No SAP Logon landscape at ${filePath}. Pass landscape_path, or set SAP_LANDSCAPE_PATH.`,
    );
  }

  let xmlContent: string;
  try {
    xmlContent = fs.readFileSync(filePath, 'utf8');
  } catch (err: any) {
    throw new Error(`Cannot read ${filePath}: ${err.message}`);
  }

  let rawData: RawLandscapeData;
  try {
    rawData = parseLandscapeXml(xmlContent, filePath);
  } catch (err: any) {
    throw new Error(`Cannot parse ${filePath}: ${err.message}`);
  }

  const { services, workspaces, warnings, unresolvedIncludes, filesRead } =
    rawData;

  // Map serviceid -> array of folder paths and workspaces
  const serviceFoldersMap = new Map<string, string[][]>();
  const serviceWorkspaceMap = new Map<string, string>();

  for (const ws of workspaces) {
    for (const item of ws.items) {
      if (!services.has(item.serviceid)) {
        warnings.push(
          `Item references unknown service id "${item.serviceid}".`,
        );
        continue;
      }
      if (!serviceFoldersMap.has(item.serviceid)) {
        serviceFoldersMap.set(item.serviceid, []);
      }
      serviceFoldersMap.get(item.serviceid)!.push(item.folders);
      if (!serviceWorkspaceMap.has(item.serviceid)) {
        serviceWorkspaceMap.set(item.serviceid, ws.name);
      }
    }
  }

  // Get available sessions for correlation
  let availableSessions: any[] = [];
  try {
    availableSessions = listAvailableSystems();
  } catch {
    // If listing fails, ignore
  }

  const systems: LandscapeSystem[] = [];

  for (const [uuid, s] of services.entries()) {
    const name = s['@_name'] || '';
    const sid = s['@_systemid'] || s['@_sid'] || '';
    const folders = serviceFoldersMap.get(uuid) || [];
    const workspace = serviceWorkspaceMap.get(uuid) || 'Local';
    const server = s['@_server'] || '';
    const routerid = s['@_routerid'];
    const viaSaprouter = !!routerid;
    if (viaSaprouter) {
      warnings.push(
        `Service "${name}" (${uuid}) routes via SAProuter. ADT requires direct HTTP(S) network access.`,
      );
    }

    const sncop = s['@_sncop'];
    const sncname = s['@_sncname'];
    const snc = sncop !== '-1' && !!sncname;

    // Check if group-logon / message server
    // Per SPEC §3.1: mode="1" is standard on direct application-server entries in SAP Logon
    // and must NOT be treated as group-logon. Only classify as group-logon if msid is present.
    const msid = s['@_msid'];
    const isMessageServer = !!msid;

    let proposedUrl: string | null = null;
    let urlReason: string | null = null;
    let instance = '';

    if (isMessageServer) {
      proposedUrl = null;
      urlReason = 'message_server';
    } else {
      const derived = deriveAdtUrl(server);
      proposedUrl = derived.proposed_url;
      urlReason = derived.url_reason;
      const parsedSrv = parseServer(server);
      instance = parsedSrv.instance;
    }

    // Match existing session
    let matchedSession: LandscapeSystemSession | null = null;
    if (server) {
      const parsedSrv = parseServer(server);
      const host = parsedSrv.host?.replace(/^\[|\]$/g, '').toLowerCase();
      if (host) {
        for (const sess of availableSessions) {
          if (sess.url) {
            try {
              const u = new URL(sess.url);
              if (u.hostname.toLowerCase() === host) {
                matchedSession = {
                  name: sess.name,
                  env_path: sess.env_path,
                  has_credentials: sess.has_credentials,
                };
                break;
              }
            } catch {
              // Ignore invalid url
            }
          }
        }
      }
    }

    systems.push({
      service_uuid: uuid,
      name,
      sid,
      sid_is_unique: false, // calculated below
      folders,
      workspace,
      server,
      instance,
      proposed_url: proposedUrl,
      url_source: 'derived',
      url_reason: urlReason,
      via_saprouter: viaSaprouter,
      snc,
      session: matchedSession,
    });
  }

  // Calculate sid_is_unique
  const sidCounts = new Map<string, number>();
  for (const sys of systems) {
    if (sys.sid) {
      sidCounts.set(sys.sid, (sidCounts.get(sys.sid) || 0) + 1);
    }
  }
  for (const sys of systems) {
    sys.sid_is_unique = !!sys.sid && sidCounts.get(sys.sid) === 1;
  }

  // Sort by folder path, then name
  systems.sort((a, b) => {
    const pathA = a.folders[0]?.join('/') || '';
    const pathB = b.folders[0]?.join('/') || '';
    const folderCmp = pathA.localeCompare(pathB);
    if (folderCmp !== 0) return folderCmp;
    return a.name.localeCompare(b.name);
  });

  return {
    landscape_path: filePath,
    files_read: filesRead,
    unresolved_includes: unresolvedIncludes,
    count: systems.length,
    systems,
    warnings,
  };
}
