import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const FALLBACK_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUMU7BpfITiifJqjgVu2HTtfS4O3owDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDkxMzE3NTMyM1oXDTM2MDkx
MDE3NTMyM1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAq75BWvye58rqiy71w8u0gx+vZt7RYNRnhSmyI78478yC
FH43LDg0/Cg0hIWwVR5e0U2th3qkRqu++pEbI/ortXr/1zwv1K0GnmU1eDNmTerI
X4U56ZTcW27wYbC+F2uxnkQDZvV/ESs71ky8OM3+Ly8hh4cdNG/M8Q1n3wbxvAKn
XmOubET48KRVGBWKLvELazBnWHOrY60ZX8ClSxzjRPtcH3JheM2l+V+z2gj7kZmZ
G4UvzOrs1FH8QYgWwvH2oluTooHM7DZEdro9y9JXgSMrBb5wHhipf8rkoQGvdguu
wrCeRSpc9hfQKWEb/g8mVjUEOPqtBemClhhkQYkWYwIDAQABo1MwUTAdBgNVHQ4E
FgQUPPNS2c5LGEd8MxSSSQTXKHy/N5swHwYDVR0jBBgwFoAUPPNS2c5LGEd8MxSS
SQTXKHy/N5swDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAHeQV
YOlZVI99GAN/6SG2DwT/ouwYOI/6ZqrY6YvMI2GSnAUOUft7j3Y3On9HY/2qkZ+5
EzcromdITbBMtsOG+8zN1TIyaCcoY9sTp0jnA3y8knbIfLeKcR37RkLCwJNpwIVz
tMJx09yfKVGAtXxLlFZOTJrzAIDzXu60n8FHzkx+l+nUIb36Wp7CN9IdBMBNTXun
QbBHYcvBSYaQRcUWKJbEhcXH1Pc702CrrTiHkkd81/ySapYDH7DdpVQWoR0/fAKr
lDRYnh6Uj5RU1CszRTl+5U4JQYxGQcybkDQ1KCa76qS1+O4+rvTIHew2sSr/iFEM
TgVlpOi6dpnCbnJ/YQ==
-----END CERTIFICATE-----
`;

const FALLBACK_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCrvkFa/J7nyuqL
LvXDy7SDH69m3tFg1GeFKbIjvzjvzIIUfjcsODT8KDSEhbBVHl7RTa2HeqRGq776
kRsj+iu1ev/XPC/UrQaeZTV4M2ZN6shfhTnplNxbbvBhsL4Xa7GeRANm9X8RKzvW
TLw4zf4vLyGHhx00b8zxDWffBvG8AqdeY65sRPjwpFUYFYou8QtrMGdYc6tjrRlf
wKVLHONE+1wfcmF4zaX5X7PaCPuRmZkbhS/M6uzUUfxBiBbC8faiW5OigczsNkR2
uj3L0leBIysFvnAeGKl/yuShAa92C67CsJ5FKlz2F9ApYRv+DyZWNQQ4+q0F6YKW
GGRBiRZjAgMBAAECggEAGjv+ycJLF8dEWqx6uET2twzxAzrIKw1nHs1Gu/Uq4l6Q
BEdfcC7J0TbnBtNRIz93ZmuCNW7Dh1QW4TmnNrCxWpCGYj98YvVnTGzTZSAc4Ywa
vZShSxAFNSZWK+YOs48s26syBdk8Zsf+5PZlzhuRV23Qpl46VNc7LBtLIaNy67AP
8izcR69+Dd7x5bF03dkfRkLhwxyg8zbgcQ0HYy+C4rS3D6WjGdFzc8ws2/Gvbt5u
yeOlkcOKtECLFLMg8iqtcEfFLG3r3r4KTl5DbD7zbeaidnmqIDidN1Dz9TJtHAuT
a0i7vZ8bh5gWDN4SqoDPV8/OreoUAGPQr5mOnUN/qQKBgQDcrRUbuykNyZyfaUP2
7ElcrEDHiRUqNDAzD6e9o7DaUga9Dj/FrsX/UekvzcLmzblWsokFypfeRb90yvHl
mET/MilQDLr+2zjvhMFtJUbyzAdV+W7H24ndqU4jMlp7RGBKCBdaGMZJDbDzovlY
/pWCtrIRoyXk7IYBHZagYcuOdwKBgQDHO/z2Jwban62gPMJR8Shh+CLlL8pqlX+e
e7yHMQBTDP94Q/CjuvrBf44Gb5S7BO8tM+mJOm0g0gzbQYuWuwnaiwqdsfrckv/P
oOuMb/bucPvOk1pbRBlIRbh8Br6ryBdfIdqgm0zNsfGL+Y1jzgHJqHu/1Q0RRh5b
gu8a38NWdQKBgGKO0vydrIpB3ze7NeWURnejXxM/ADrnMBe+CDbEYvo+5E+Pi5/o
nPmZRcJZ7ZBTlVFJT7VMdGOLVyT8dukKBtbLOnRMG0Az/MvMyO7MVVGfGi+lxXpx
bLOZKBLELHEdarvlvTg6FGUQPlWyFhdPLMtCeWkzKnuBv5/D7UAYLWelAoGBAKSs
36wxm8eufdtY/SCvnLpFV8ppkvw/70j2a2Cuzt7Wen5UYZ1jWgn/vUtyhNOEA5Ew
PFJx2WtsUrYTWiZPGJjrne20A263jft2vdrJXKe++VLIlsGi6ubCwfa5uHXSIAdA
uy1Oz8+gyc7xiL06tF2TBh4MIg3qEAOBmNJ0q0dVAoGBANmR4nLlls1rkWPAcXl8
RIwTvS0lsBIUPW9TyA4b7XD/ZCEKYyPrNKpvuHVzbVa3y2oHRx4KTQBRGiEcodRE
Cwas44CEzCFz3t+wBZpxmvCe7Gy/VaYpzNpM0MIzb2li0tRBoRq+Wau08DwSq9PU
loKr0rqRoGYSQW8yEx7EhINq
-----END PRIVATE KEY-----
`;

function findOpenSsl(): string | null {
  if (process.env.OPENSSL_BIN && fs.existsSync(process.env.OPENSSL_BIN)) {
    return process.env.OPENSSL_BIN;
  }
  const candidates = [
    'openssl',
    ...(process.platform === 'win32'
      ? [
          path.join(
            process.env.ProgramFiles || 'C:\\Program Files',
            'Git',
            'usr',
            'bin',
            'openssl.exe',
          ),
          path.join(
            process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
            'Git',
            'usr',
            'bin',
            'openssl.exe',
          ),
          'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
          'C:\\OpenSSL-Win64\\bin\\openssl.exe',
        ]
      : []),
  ];
  for (const candidate of candidates) {
    try {
      execSync(`"${candidate}" version`, { stdio: 'ignore' });
      return candidate;
    } catch {
      // Continue searching
    }
  }
  return null;
}

/**
 * Generate or provision a self-signed certificate for testing purposes.
 * Uses openssl CLI when available, falling back to a pre-generated self-signed test certificate.
 */
export function createSelfSignedCert(): {
  cert: string;
  key: string;
  dir: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tls-test-'));
  const certPath = path.join(dir, 'server.crt');
  const keyPath = path.join(dir, 'server.key');

  const openssl = findOpenSsl();
  if (openssl) {
    try {
      execSync(
        `"${openssl}" req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`,
        { stdio: 'pipe' },
      );
      if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        return { cert: certPath, key: keyPath, dir };
      }
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: write pre-generated test certificate and key
  fs.writeFileSync(certPath, FALLBACK_CERT, 'utf8');
  fs.writeFileSync(keyPath, FALLBACK_KEY, 'utf8');
  return { cert: certPath, key: keyPath, dir };
}
