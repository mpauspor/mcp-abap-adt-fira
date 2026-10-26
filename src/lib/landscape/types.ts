/**
 * Type definitions for SAP Logon landscape reading, URL derivation,
 * probing, credential storage, and session generation.
 */

export interface AdtUrlProposal {
  proposed_url: string | null;
  url_source: 'derived' | 'explicit';
  url_reason:
    | 'no_port'
    | 'unexpected_port'
    | 'unparsed_server'
    | 'message_server'
    | null;
}

export interface ProbeResult {
  reachable: boolean;
  dns: 'ok' | 'fail';
  tcp: 'open' | 'closed' | 'timeout' | 'skipped';
  http_status: number | null;
  tls: 'trusted' | 'untrusted' | null;
  icf: 'requires_logon' | 'not_found' | 'unknown';
  ms: number;
  error?: string | null;
}

export interface LandscapeSystemSession {
  name: string;
  env_path: string;
  has_credentials: boolean;
}

export interface LandscapeSystem {
  service_uuid: string;
  name: string;
  sid: string;
  sid_is_unique: boolean;
  folders: string[][];
  workspace: string;
  server: string;
  instance: string;
  proposed_url: string | null;
  url_source: 'derived';
  url_reason: string | null;
  via_saprouter: boolean;
  snc: boolean;
  session: LandscapeSystemSession | null;
  probe?: ProbeResult;
}

export interface LandscapeParseResult {
  landscape_path: string;
  files_read: string[];
  unresolved_includes: string[];
  count: number;
  systems: LandscapeSystem[];
  warnings: string[];
}

export interface SetupSystemOptions {
  service_uuid: string;
  client: string;
  username: string;
  name?: string;
  url?: string;
  system_type?: 'onprem' | 'legacy' | 'cloud';
  language?: string;
  require_reachable?: boolean;
  overwrite?: boolean;
  landscape_path?: string;
}

export interface SetupSystemResult {
  success: true;
  name: string;
  env_path: string;
  verified: true;
  url: string;
  url_source: 'derived' | 'explicit';
  probe: ProbeResult;
  credential: {
    target: string;
    present: boolean | 'unknown';
    error?: number;
  };
  next_steps: string[];
  warnings: string[];
}
