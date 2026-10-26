import { spawnSync } from 'node:child_process';

export const TARGET_REGEX = /^mcp-abap-adt:[a-z0-9][a-z0-9_-]{0,31}$/;

const POWERSHELL_CRED_SCRIPT = `
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    [Console]::Error.WriteLine("PowerShell LanguageMode: $($ExecutionContext.SessionState.LanguageMode)")
    exit 2
}

$memberDef = @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
}

[DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

[DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
public static extern void CredFree(IntPtr credentialPtr);
'@

Add-Type -MemberDefinition $memberDef -Name Cred -Namespace AdvApi

$target = $env:MCP_CRED_TARGET
$mode = $env:MCP_CRED_MODE
$ptr = [IntPtr]::Zero
$ok = [AdvApi.Cred]::CredRead($target, 1, 0, [ref]$ptr)
if (-not $ok) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Output (ConvertTo-Json -Compress @{ present = $false; last_error = $err })
    exit 0
}
try {
    if ($mode -eq 'exist') {
        Write-Output (ConvertTo-Json -Compress @{ present = $true })
        exit 0
    }
    $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][AdvApi.Cred+CREDENTIAL])
    $bytes = New-Object byte[] $cred.CredentialBlobSize
    if ($cred.CredentialBlobSize -gt 0 -and $cred.CredentialBlob -ne [IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
    }
    $b64 = [Convert]::ToBase64String($bytes)
    $obj = @{ present = $true; user = $cred.UserName; secret_b64 = $b64 }
    Write-Output (ConvertTo-Json -Compress @{ present = $true; user = $cred.UserName; secret_b64 = $b64 })
} finally {
    [AdvApi.Cred]::CredFree($ptr)
}
`;

export interface CredentialEntry {
  user: string;
  secret: string;
}

export interface CredentialExistence {
  present: boolean | 'unknown';
  error?: number;
}

function isConstrainedLanguageMode(stderr: string): boolean {
  return (
    stderr.includes('ConstrainedLanguage') ||
    stderr.includes('LanguageMode: ConstrainedLanguage') ||
    (stderr.includes('Add-Type') &&
      (stderr.includes('Cannot add type') ||
        stderr.includes('is not permitted in this language mode')))
  );
}

const CLM_ERROR_MSG =
  'Windows Credential Manager is not usable here: PowerShell Add-Type is blocked (Constrained Language Mode). Put SAP_PASSWORD in the .env file or ask IT to allow it.';

const credentialCache = new Map<string, CredentialEntry>();

/**
 * Clear the in-memory cache (primarily for unit tests).
 */
export function clearCredentialCache(): void {
  credentialCache.clear();
}

/**
 * Check if a credential target exists in Windows Credential Manager without reading secret.
 */
export function checkCredentialTarget(target: string): CredentialExistence {
  if (!TARGET_REGEX.test(target)) {
    throw new Error(
      `Invalid credential target "${target}". Expected format: mcp-abap-adt:<name>`,
    );
  }

  if (credentialCache.has(target)) {
    return { present: true };
  }

  if (process.platform !== 'win32') {
    throw new Error(
      `SAP_CREDENTIAL_TARGET is set but no credential store is available on ${process.platform}.`,
    );
  }

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_CRED_SCRIPT],
    {
      windowsHide: true,
      timeout: 10000,
      env: {
        ...process.env,
        MCP_CRED_TARGET: target,
        MCP_CRED_MODE: 'exist',
      },
    },
  );

  const stderr = result.stderr ? result.stderr.toString() : '';
  if (isConstrainedLanguageMode(stderr)) {
    throw new Error(CLM_ERROR_MSG);
  }

  if (result.status !== 0 && !result.stdout) {
    return { present: 'unknown', error: result.status ?? undefined };
  }

  try {
    const raw = result.stdout ? result.stdout.toString().trim() : '';
    const parsed = JSON.parse(raw);
    if (parsed.present === true) {
      return { present: true };
    }
    if (parsed.present === false) {
      if (parsed.last_error === 1168) {
        return { present: false, error: 1168 };
      }
      return { present: 'unknown', error: parsed.last_error };
    }
  } catch {
    // If output could not be parsed as JSON
  }

  return { present: 'unknown' };
}

/**
 * Read the credential (user and secret) for target from Windows Credential Manager.
 */
export function readCredentialTarget(
  target: string,
  expectedUsername?: string,
): CredentialEntry {
  if (!TARGET_REGEX.test(target)) {
    throw new Error(
      `Invalid credential target "${target}". Expected format: mcp-abap-adt:<name>`,
    );
  }

  const cached = credentialCache.get(target);
  if (cached) {
    return cached;
  }

  if (process.platform !== 'win32') {
    throw new Error(
      `SAP_CREDENTIAL_TARGET is set but no credential store is available on ${process.platform}.`,
    );
  }

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_CRED_SCRIPT],
    {
      windowsHide: true,
      timeout: 10000,
      env: {
        ...process.env,
        MCP_CRED_TARGET: target,
        MCP_CRED_MODE: 'read',
      },
    },
  );

  const stderr = result.stderr ? result.stderr.toString() : '';
  if (isConstrainedLanguageMode(stderr)) {
    throw new Error(CLM_ERROR_MSG);
  }

  let parsed: any;
  try {
    const raw = result.stdout ? result.stdout.toString().trim() : '';
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Failed to read credential from Windows Credential Manager: ${stderr || 'Unknown execution error'}`,
    );
  }

  if (!parsed.present) {
    if (parsed.last_error === 1168) {
      const userHint = expectedUsername ? ` /user:${expectedUsername}` : '';
      throw new Error(
        `Credential ${target} not found in Windows Credential Manager. Create it with: cmdkey /generic:${target}${userHint} /pass`,
      );
    }
    throw new Error(
      `Failed to read credential ${target} from Windows Credential Manager (Win32 error: ${parsed.last_error}).`,
    );
  }

  const storedUser = parsed.user || '';
  const secretB64 = parsed.secret_b64 || '';
  const secret = Buffer.from(secretB64, 'base64')
    .toString('utf16le')
    .replace(/\0+$/, '');

  const entry: CredentialEntry = {
    user: storedUser,
    secret,
  };

  credentialCache.set(target, entry);
  return entry;
}
