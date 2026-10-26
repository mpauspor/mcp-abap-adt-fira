import type { AdtUrlProposal } from './types';

export interface ParseServerResult {
  host: string | null;
  port: string | null;
  instance: string;
  error?: 'no_port' | 'unparsed_server';
}

/**
 * Parse a SAP server string like "host:3200", "[fd00::1]:3200", or "host".
 */
export function parseServer(server: string): ParseServerResult {
  if (!server || typeof server !== 'string') {
    return { host: null, port: null, instance: '', error: 'unparsed_server' };
  }

  const trimmed = server.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return { host: null, port: null, instance: '', error: 'unparsed_server' };
  }

  // IPv6 in brackets: [ipv6]:port or [ipv6]
  if (trimmed.startsWith('[')) {
    const closingBracket = trimmed.indexOf(']');
    if (closingBracket === -1) {
      return { host: null, port: null, instance: '', error: 'unparsed_server' };
    }
    const host = trimmed.slice(0, closingBracket + 1);
    const remainder = trimmed.slice(closingBracket + 1);
    if (!remainder) {
      return { host, port: null, instance: '', error: 'no_port' };
    }
    if (!remainder.startsWith(':')) {
      return { host: null, port: null, instance: '', error: 'unparsed_server' };
    }
    const port = remainder.slice(1);
    if (!/^\d+$/.test(port)) {
      return { host: null, port: null, instance: '', error: 'unparsed_server' };
    }
    const match = /^32(\d{2})$/.exec(port);
    return {
      host,
      port,
      instance: match ? match[1] : '',
    };
  }

  // Count colons
  const colonParts = trimmed.split(':');
  if (colonParts.length === 1) {
    // No port
    const host = colonParts[0];
    if (!host) {
      return { host: null, port: null, instance: '', error: 'unparsed_server' };
    }
    return { host, port: null, instance: '', error: 'no_port' };
  }

  if (colonParts.length === 2) {
    const [host, port] = colonParts;
    if (!host || !port || !/^\d+$/.test(port)) {
      return { host: null, port: null, instance: '', error: 'unparsed_server' };
    }
    const match = /^32(\d{2})$/.exec(port);
    return {
      host,
      port,
      instance: match ? match[1] : '',
    };
  }

  // Multiple colons without brackets (e.g. unbracketed IPv6) -> unparsed_server
  return { host: null, port: null, instance: '', error: 'unparsed_server' };
}

/**
 * Derives an ADT HTTPS URL from a SAP GUI server string.
 *
 * SAP DIAG convention uses port 32NN where NN is the two-digit instance number.
 * ADT HTTPS uses port 443NN.
 */
export function deriveAdtUrl(
  server: string,
  explicitUrl?: string,
): AdtUrlProposal {
  if (explicitUrl) {
    return {
      proposed_url: explicitUrl,
      url_source: 'explicit',
      url_reason: null,
    };
  }

  const parsed = parseServer(server);
  if (parsed.error === 'unparsed_server' || !parsed.host) {
    return {
      proposed_url: null,
      url_source: 'derived',
      url_reason: 'unparsed_server',
    };
  }

  if (parsed.error === 'no_port' || !parsed.port) {
    return {
      proposed_url: null,
      url_source: 'derived',
      url_reason: 'no_port',
    };
  }

  const match = /^32(\d{2})$/.exec(parsed.port);
  if (!match) {
    return {
      proposed_url: null,
      url_source: 'derived',
      url_reason: 'unexpected_port',
    };
  }

  const instance = match[1];
  return {
    proposed_url: `https://${parsed.host}:443${instance}`,
    url_source: 'derived',
    url_reason: null,
  };
}
