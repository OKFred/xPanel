[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$hostName = 'com.okfred.xpanel'
$installDirectory = Join-Path $env:LOCALAPPDATA 'OKFred\xPanel\NativeHost'
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"

if (Test-Path -LiteralPath $registryPath) {
  Remove-Item -LiteralPath $registryPath -Recurse -Force
}

$expectedParent = (Join-Path $env:LOCALAPPDATA 'OKFred\xPanel')
$resolvedParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $installDirectory))
if ($resolvedParent -ne [System.IO.Path]::GetFullPath($expectedParent)) {
  throw "Refusing to remove unexpected directory: $installDirectory"
}
if (Test-Path -LiteralPath $installDirectory) {
  $installedExecutable = Join-Path $installDirectory 'xpanel-native-host.exe'
  $manifestPath = Join-Path $installDirectory "$hostName.json"
  Remove-Item -LiteralPath $installedExecutable -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue
  # Do not recursively delete this directory: an unexpected user file or junction
  # must make uninstall leave the directory in place instead of broadening scope.
  Remove-Item -LiteralPath $installDirectory -Force -ErrorAction SilentlyContinue
}

Write-Host "Uninstalled $hostName"
