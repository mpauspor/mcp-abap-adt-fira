import * as dns from 'node:dns';
import * as https from 'node:https';
import * as net from 'node:net';
import type { LandscapeSystem, ProbeResult } from './types';

const DNS_TIMEOUT_MS = 2000;
const TCP_TIMEOUT_MS = 2000;
const HTTP_TIMEOUT_MS = 5000;

function isCertError(err: any): boolean {
  if (!err) return false;
  const code = err.code || '';
  const msg = (err.message || '').toLowerCase();
  return (
    code.startsWith('CERT_') ||
    code.startsWith('DEPTH_ZERO_') ||
    code.startsWith('UNABLE_TO_VERIFY_') ||
    code.startsWith('SELF_SIGNED_') ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    msg.includes('certificate') ||
    msg.includes('self-signed') ||
    msg.includes('self signed')
  );
}

function resolveDns(hostname: string): Promise<'ok' | 'fail'> {
  return new Promise((resolve) => {
    let settled = false;
    const cleanHost = hostname.replace(/^\[|\]$/g, '');

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve('fail');
      }
    }, DNS_TIMEOUT_MS);

    dns.lookup(cleanHost, (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(err ? 'fail' : 'ok');
      }
    });
  });
}

function testTcp(
  hostname: string,
  port: number,
): Promise<'open' | 'closed' | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false;
    const cleanHost = hostname.replace(/^\[|\]$/g, '');

    const socket = new net.Socket();
    socket.setTimeout(TCP_TIMEOUT_MS);

    const finish = (result: 'open' | 'closed' | 'timeout') => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(result);
      }
    };

    socket.once('connect', () => finish('open'));
    socket.once('timeout', () => finish('timeout'));
    socket.once('error', () => finish('closed'));

    try {
      socket.connect(port, cleanHost);
    } catch {
      finish('closed');
    }
  });
}

interface HttpsProbeOutcome {
  status: number | null;
  tls: 'trusted' | 'untrusted' | null;
  error?: any;
}

function requestDiscovery(
  url: URL,
  rejectUnauthorized: boolean,
): Promise<HttpsProbeOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const options: https.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || 443,
      path: '/sap/bc/adt/core/discovery',
      method: 'GET',
      rejectUnauthorized,
      headers: {
        'User-Agent': 'mcp-abap-adt-probe',
      },
      timeout: HTTP_TIMEOUT_MS,
    };

    const req = https.request(options, (res) => {
      if (!settled) {
        settled = true;
        const status = res.statusCode ?? null;
        res.resume(); // consume stream
        req.destroy();
        resolve({
          status,
          tls: rejectUnauthorized ? 'trusted' : 'untrusted',
        });
      }
    });

    req.on('timeout', () => {
      if (!settled) {
        settled = true;
        req.destroy(new Error('HTTP timeout'));
        resolve({
          status: null,
          tls: null,
          error: new Error('HTTP timeout'),
        });
      }
    });

    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        req.destroy();
        resolve({
          status: null,
          tls: null,
          error: err,
        });
      }
    });

    req.end();
  });
}

/**
 * Probe a single system given its proposed URL.
 */
export async function probeSystem(proposedUrl: string): Promise<ProbeResult> {
  const start = Date.now();
  let url: URL;
  try {
    url = new URL(proposedUrl);
  } catch {
    return {
      reachable: false,
      dns: 'fail',
      tcp: 'skipped',
      http_status: null,
      tls: null,
      icf: 'unknown',
      ms: Date.now() - start,
    };
  }

  const hostname = url.hostname;
  const port = parseInt(url.port || '443', 10);

  // 1. DNS lookup (2s)
  const dnsStatus = await resolveDns(hostname);
  if (dnsStatus !== 'ok') {
    return {
      reachable: false,
      dns: 'fail',
      tcp: 'skipped',
      http_status: null,
      tls: null,
      icf: 'unknown',
      ms: Date.now() - start,
      error: 'ENOTFOUND',
    };
  }

  // 2. TCP connect (2s)
  const tcpStatus = await testTcp(hostname, port);
  if (tcpStatus !== 'open') {
    return {
      reachable: false,
      dns: 'ok',
      tcp: tcpStatus,
      http_status: null,
      tls: null,
      icf: 'unknown',
      ms: Date.now() - start,
      error: tcpStatus === 'timeout' ? 'ETIMEDOUT' : 'ECONNREFUSED',
    };
  }

  // 3. HTTPS GET /sap/bc/adt/core/discovery (no auth, no cookies, no redirects)
  let outcome = await requestDiscovery(url, true);

  if (outcome.error && isCertError(outcome.error)) {
    // Retry once with rejectUnauthorized: false
    const retryOutcome = await requestDiscovery(url, false);
    if (retryOutcome.status !== null) {
      outcome = {
        status: retryOutcome.status,
        tls: 'untrusted',
      };
    } else {
      outcome = {
        status: null,
        tls: 'untrusted',
        error: retryOutcome.error,
      };
    }
  }

  let icf: 'requires_logon' | 'not_found' | 'unknown' = 'unknown';
  if (outcome.status !== null) {
    if (
      outcome.status === 200 ||
      (outcome.status >= 300 && outcome.status < 400) ||
      outcome.status === 401
    ) {
      icf = 'requires_logon';
    } else if (outcome.status === 404) {
      icf = 'not_found';
    } else {
      icf = 'unknown';
    }
  }

  const reachable =
    dnsStatus === 'ok' && tcpStatus === 'open' && icf === 'requires_logon';

  let error: string | null = null;
  if (!reachable) {
    if (outcome.error) {
      error =
        typeof outcome.error === 'string'
          ? outcome.error
          : outcome.error.code ||
            outcome.error.message ||
            String(outcome.error);
    } else {
      error = 'UNREACHABLE';
    }
  }

  return {
    reachable,
    dns: dnsStatus,
    tcp: tcpStatus,
    http_status: outcome.status,
    tls: outcome.tls,
    icf,
    ms: Date.now() - start,
    error,
  };
}

/**
 * Probe a batch of systems with concurrency limit and total budget.
 */
export async function probeBatch(
  systems: LandscapeSystem[],
  maxConcurrency = 5,
  totalBudgetMs = 10000,
): Promise<void> {
  const startTime = Date.now();
  let index = 0;

  async function worker() {
    while (index < systems.length) {
      if (Date.now() - startTime >= totalBudgetMs) {
        break;
      }
      const currentIndex = index++;
      const sys = systems[currentIndex];
      if (sys.proposed_url) {
        sys.probe = await probeSystem(sys.proposed_url);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(maxConcurrency, systems.length) },
    () => worker(),
  );
  await Promise.all(workers);
}
