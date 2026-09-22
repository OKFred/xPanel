param(
  [ValidateSet('inventory','create','ready','key','delete')][string]$Action = 'inventory',
  [string]$StateDirectory,
  [string]$ProjectName
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class XPanelSupabaseCredential {
  [StructLayout(LayoutKind.Sequential)] private struct Credential {
    public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll")] private static extern void CredFree(IntPtr credential);
  public static string Read() {
    IntPtr pointer;
    if (!CredRead("Supabase CLI:supabase", 1, 0, out pointer)) throw new Exception("Supabase CLI credential unavailable");
    try {
      var credential = Marshal.PtrToStructure<Credential>(pointer);
      var bytes = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
      var token = Encoding.UTF8.GetString(bytes); Array.Clear(bytes, 0, bytes.Length);
      if (!token.StartsWith("sbp_") || token.Length < 20) throw new Exception("Unexpected Supabase credential format");
      return token;
    } finally { CredFree(pointer); }
  }
}
'@
$taskClient = [Net.Http.HttpClient]::new()
$taskClient.Timeout = [TimeSpan]::FromSeconds(45)
$taskClient.DefaultRequestHeaders.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', [XPanelSupabaseCredential]::Read())
function Invoke-TaskApi([string]$Method, [string]$Path, $Body = $null) {
  $taskRequest = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Method), 'https://api.supabase.com' + $Path)
  if ($null -ne $Body) { $taskRequest.Content = [Net.Http.StringContent]::new(($Body | ConvertTo-Json -Depth 20 -Compress), [Text.Encoding]::UTF8, 'application/json') }
  try {
    $taskResponse = $taskClient.SendAsync($taskRequest).GetAwaiter().GetResult()
    try {
      if (-not $taskResponse.IsSuccessStatusCode) { throw ('Supabase API HTTP ' + [int]$taskResponse.StatusCode) }
      $taskContent = $taskResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if ($taskContent) { return $taskContent | ConvertFrom-Json -AsHashtable }
    } finally { $taskResponse.Dispose() }
  } finally { $taskRequest.Dispose() }
}
function Save-TaskState {
  $taskState.updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  [IO.File]::WriteAllText($taskStatePath, ($taskState | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
}
try {
  $taskProjects = @(Invoke-TaskApi 'GET' '/v1/projects')
  $taskOrganizations = @(Invoke-TaskApi 'GET' '/v1/organizations')
  if ($Action -eq 'inventory') {
    @{ organizations = @($taskOrganizations | ForEach-Object { @{ id=$_.id; name=$_.name } }); projects = @($taskProjects | ForEach-Object { @{ id=$_.id; name=$_.name; organization_id=$_.organization_id; status=$_.status } }) } | ConvertTo-Json -Depth 6
    return
  }
  if ($ProjectName -notmatch '^xpanel-three-[a-f0-9]{12}$') { throw 'Unexpected temporary project name' }
  $taskPrivatePath = [IO.Path]::GetFullPath($StateDirectory)
  if ([IO.Path]::GetDirectoryName($taskPrivatePath) -ne [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') -or [IO.Path]::GetFileName($taskPrivatePath) -notlike 'xpanel-one-fetch-supabase-*') { throw 'Unexpected private directory' }
  if (-not (Get-Acl -LiteralPath $taskPrivatePath).AreAccessRulesProtected) { throw 'Private directory must have restricted ACL' }
  $taskStatePath = Join-Path $taskPrivatePath 'platform.json'
  if (Test-Path -LiteralPath $taskStatePath) { $taskState = Get-Content -LiteralPath $taskStatePath -Raw | ConvertFrom-Json -AsHashtable }
  else {
    if ($Action -ne 'create') { throw 'Creation ownership journal missing' }
    if ($taskOrganizations.Count -ne 1) { throw 'Select one organization explicitly before creating acceptance resources' }
    $taskState = @{ schemaVersion=1; name=$ProjectName; organizationId=$taskOrganizations[0].id; createdAt=[DateTimeOffset]::UtcNow.ToString('o') }
  }
  if ($taskState.name -ne $ProjectName) { throw 'Project ownership journal mismatch' }
  if ($Action -eq 'create') {
    $taskOrg = Invoke-TaskApi 'GET' ('/v1/organizations/' + $taskState.organizationId)
    if ($taskOrg.plan -ne 'free') { throw 'Only confirmed Free plan acceptance is authorized' }
    if ($taskState.createRequestedAt -or @($taskProjects | Where-Object { $_.name -eq $ProjectName }).Count) { throw 'Ambiguous/repeated creation; inspect inventory instead' }
    $taskPassword = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36)).Replace('+','A').Replace('/','b')
    [IO.File]::WriteAllText((Join-Path $taskPrivatePath 'database-password'), $taskPassword, [Text.UTF8Encoding]::new($false))
    $taskState.createRequestedAt = [DateTimeOffset]::UtcNow.ToString('o'); Save-TaskState
    $taskCreated = Invoke-TaskApi 'POST' '/v1/projects' @{ name=$ProjectName; organization_slug=$taskState.organizationId; db_pass=$taskPassword; region='ap-southeast-1'; plan='free' }
    if ($taskCreated.id -notmatch '^[a-z0-9]{20}$' -or $taskCreated.name -ne $ProjectName) { throw 'Unexpected created identity; inspect inventory' }
    $taskState.projectRef = $taskCreated.id; Save-TaskState
  } else {
    $taskOwned = @($taskProjects | Where-Object { $_.id -eq $taskState.projectRef -and $_.name -eq $ProjectName -and $_.organization_id -eq $taskState.organizationId })
    if ($taskOwned.Count -ne 1) { throw 'Exact temporary project ownership not established' }
    $taskState.status = $taskOwned[0].status
    if ($Action -eq 'key') {
      $taskKeys = @(Invoke-TaskApi 'GET' ('/v1/projects/' + $taskState.projectRef + '/api-keys?reveal=true'))
      $taskKey = @($taskKeys | Where-Object { $_.name -eq 'service_role' -and $_.type -eq 'legacy' })
      if ($taskKey.Count -ne 1) { throw 'Expected service role key unavailable' }
      [IO.File]::WriteAllText((Join-Path $taskPrivatePath 'service-role-key'), $taskKey[0].api_key, [Text.UTF8Encoding]::new($false))
    }
    if ($Action -eq 'delete') {
      # Only the random project created by this journal; no pause/restore API exists here.
      $null = Invoke-TaskApi 'DELETE' ('/v1/projects/' + $taskState.projectRef)
      $taskRemaining = @(Invoke-TaskApi 'GET' '/v1/projects')
      $taskState.absent = @($taskRemaining | Where-Object { $_.id -eq $taskState.projectRef -or $_.name -eq $ProjectName }).Count -eq 0
      if (-not $taskState.absent) { throw 'Deletion not yet confirmed; keep ownership journal' }
    }
    Save-TaskState
  }
  $taskState | ConvertTo-Json -Depth 10
} finally { $taskClient.Dispose() }
