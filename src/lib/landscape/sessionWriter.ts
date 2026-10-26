import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { sessionsDirectories } from '../adt/secondarySystem';
import type { ProbeResult, SetupSystemResult } from './types';

export interface WriteSessionParams {
  name: string;
  serviceName: string;
  serviceUuid: string;
  url: string;
  client: string;
  username: string;
  sid: string;
  systemType: string;
  language: string;
  probe: ProbeResult;
  overwrite?: boolean;
  allowUntrustedTls?: boolean;
}

/**
 * Validate session name: ^[a-z0-9][a-z0-9_-]{0,31}$
 */
export function validateSessionName(name: string): void {
  if (!name || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) {
    throw new Error(
      `Invalid system name "${name}". Name must match ^[a-z0-9][a-z0-9_-]{0,31}$ (lowercase alphanumeric, underscores, hyphens, max 32 characters).`,
    );
  }
}

/**
 * Write a session file atomically to the sessions directory and verify its contents.
 */
export function writeSessionFile(params: WriteSessionParams): {
  envPath: string;
  warnings: string[];
} {
  const {
    name,
    serviceName,
    serviceUuid,
    url,
    client,
    username,
    sid,
    systemType,
    language,
    probe,
    overwrite,
    allowUntrustedTls,
  } = params;

  validateSessionName(name);

  const dirs = sessionsDirectories();
  const sessionsDir = dirs[0] || path.resolve(process.cwd(), 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  const targetPath = path.join(sessionsDir, `${name}.env`);
  const warnings: string[] = [];

  if (fs.existsSync(targetPath)) {
    let existingUrl = '';
    let hasPassword = false;
    try {
      const existing = dotenv.parse(fs.readFileSync(targetPath, 'utf8'));
      existingUrl = existing.SAP_URL || '';
      hasPassword = !!existing.SAP_PASSWORD;
    } catch {
      // Ignore parse failure of existing file
    }

    if (!overwrite) {
      let msg = `${targetPath} already exists (points at ${existingUrl || 'unknown'}). Pass overwrite: true to replace it, or choose another name.`;
      if (hasPassword) {
        msg +=
          ' Replacing it drops the stored password; store it with cmdkey first.';
      }
      throw new Error(msg);
    }
  }

  // Decide TLS_REJECT_UNAUTHORIZED per SPEC §3.5 & §3.8
  let tlsReject = '1';
  let hostName = 'target';
  try {
    hostName = new URL(url).hostname;
  } catch {
    // ignore
  }

  if (probe.tls === 'untrusted') {
    if (allowUntrustedTls) {
      tlsReject = '0';
      warnings.push(
        'Target uses an untrusted TLS certificate and allow_untrusted_tls is true. Setting TLS_REJECT_UNAUTHORIZED=0 in session file (turns verification off for the whole server when this session is active).',
      );
    } else {
      tlsReject = '1';
      warnings.push(
        `The certificate of ${hostName} is not trusted. Connecting will fail until its CA is trusted (Windows certificate store); if it is self-signed on purpose, re-run with allow_untrusted_tls: true to write TLS_REJECT_UNAUTHORIZED=0, which turns verification off for every system this server connects to.`,
      );
    }
  } else if (probe.tls === null) {
    tlsReject = '1';
    warnings.push(
      'Probe did not reach the TLS step (host unreachable). Defaulting TLS_REJECT_UNAUTHORIZED=1. Relax to 0 if the system uses an untrusted certificate.',
    );
  }

  const expectedValues: Record<string, string> = {
    SAP_URL: url,
    SAP_CLIENT: client,
    SAP_USERNAME: username,
    SAP_AUTH_TYPE: 'basic',
    SAP_SYSTEM_TYPE: systemType,
    SAP_MASTER_SYSTEM: sid,
    SAP_RESPONSIBLE: username,
    SAP_LANGUAGE: language,
    SAP_CREDENTIAL_TARGET: `mcp-abap-adt:${name}`,
    TLS_REJECT_UNAUTHORIZED: tlsReject,
  };

  // biome-ignore lint/suspicious/noControlCharactersInRegex: sanitize logon entry name in comment
  const sanitizedServiceName = serviceName.replace(/[\r\n\x00-\x1f\x7f]/g, ' ');
  const fileLines = [
    `# Written by SetupSystem from SAP Logon entry "${sanitizedServiceName}" (${serviceUuid})`,
    `SAP_URL=${expectedValues.SAP_URL}`,
    `SAP_CLIENT=${expectedValues.SAP_CLIENT}`,
    `SAP_USERNAME=${expectedValues.SAP_USERNAME}`,
    `SAP_AUTH_TYPE=${expectedValues.SAP_AUTH_TYPE}`,
    `SAP_SYSTEM_TYPE=${expectedValues.SAP_SYSTEM_TYPE}`,
    `SAP_MASTER_SYSTEM=${expectedValues.SAP_MASTER_SYSTEM}`,
    `SAP_RESPONSIBLE=${expectedValues.SAP_RESPONSIBLE}`,
    `SAP_LANGUAGE=${expectedValues.SAP_LANGUAGE}`,
    `SAP_CREDENTIAL_TARGET=${expectedValues.SAP_CREDENTIAL_TARGET}`,
    `TLS_REJECT_UNAUTHORIZED=${expectedValues.TLS_REJECT_UNAUTHORIZED}`,
    '',
  ];

  const content = fileLines.join('\n');
  const tempPath = path.join(
    sessionsDir,
    `.${name}.env.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`,
  );

  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, targetPath);
  } catch (err: any) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Ignore temp cleanup error
    }
    throw new Error(
      `Failed to write session file ${targetPath}: ${err.message}`,
    );
  }

  // Verification read-back (D-005)
  let parsedReadBack: Record<string, string>;
  try {
    parsedReadBack = dotenv.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch (err: any) {
    throw new Error(
      `Verification failed: could not parse written session file ${targetPath}: ${err.message}`,
    );
  }

  const mismatchedKeys: string[] = [];
  for (const [key, expectedVal] of Object.entries(expectedValues)) {
    if (parsedReadBack[key] !== expectedVal) {
      mismatchedKeys.push(
        `${key} (expected "${expectedVal}", found "${parsedReadBack[key]}")`,
      );
    }
  }

  if (mismatchedKeys.length > 0) {
    throw new Error(
      `Verification mismatch in ${targetPath} for keys: ${mismatchedKeys.join(', ')}`,
    );
  }

  return {
    envPath: targetPath,
    warnings,
  };
}
