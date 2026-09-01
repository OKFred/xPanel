[CmdletBinding()]
param(
  [Parameter()]
  [string]$HostExecutable = (Join-Path $PSScriptRoot '..\dist\sea\win32-x64\xpanel-native-host.exe'),

  [Parameter()]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId = 'diaemdialoooebdennhpgnmobnjabohm'
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.okfred.xpanel'
$sourceExecutable = (Resolve-Path -LiteralPath $HostExecutable).Path
$installDirectory = Join-Path $env:LOCALAPPDATA 'OKFred\xPanel\NativeHost'
$installedExecutable = Join-Path $installDirectory 'xpanel-native-host.exe'
$manifestPath = Join-Path $installDirectory "$hostName.json"
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"

if (-not [System.IO.Path]::GetExtension($sourceExecutable).Equals('.exe', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'HostExecutable must point to the generated xpanel-native-host.exe.'
}

$curlCommand = Get-Command -Name 'curl.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1
$processInfo = [System.Diagnostics.ProcessStartInfo]::new()
$processInfo.FileName = $curlCommand.Source
$processInfo.Arguments = '--disable --version'
$processInfo.UseShellExecute = $false
$processInfo.CreateNoWindow = $true
$processInfo.RedirectStandardOutput = $true
$processInfo.RedirectStandardError = $true
$curlProcess = [System.Diagnostics.Process]::Start($processInfo)
$curlOutput = $curlProcess.StandardOutput.ReadToEnd()
$curlError = $curlProcess.StandardError.ReadToEnd()
$curlProcess.WaitForExit()
if ($curlProcess.ExitCode -ne 0) {
  throw "curl preflight failed: $curlError"
}
if ($curlOutput -notmatch '^curl\s+(?<version>\d+\.\d+(?:\.\d+)?)') {
  throw 'curl preflight returned an unrecognized version.'
}
$curlVersion = [version]$Matches.version
if ($curlVersion -lt [version]'7.70.0') {
  throw "curl 7.70.0 or newer is required; found $curlVersion."
}

New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
Copy-Item -LiteralPath $sourceExecutable -Destination $installedExecutable -Force

$manifest = [ordered]@{
  name = $hostName
  description = 'xPanel secure native HTTP companion'
  path = $installedExecutable
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM

New-Item -Path $registryPath -Force | Out-Null
Set-Item -LiteralPath $registryPath -Value $manifestPath
Write-Host "Installed $hostName for chrome-extension://$ExtensionId/"
Write-Host "Manifest: $manifestPath"
