$ErrorActionPreference = 'Stop'

$GeminiUrl = 'https://gemini.google.com/app'
$BridgeClientsUrl = if ($env:GEMINI_MCP_BRIDGE_CLIENTS_URL) {
  $env:GEMINI_MCP_BRIDGE_CLIENTS_URL
} else {
  'http://127.0.0.1:47283/agent/clients'
}
$BridgeTimeoutMs = 500
if ($env:GEMINI_MCP_HOOK_BRIDGE_TIMEOUT_MS -as [int]) {
  $BridgeTimeoutMs = [int]$env:GEMINI_MCP_HOOK_BRIDGE_TIMEOUT_MS
}
$CooldownMs = 60000
if ($env:GEMINI_MCP_BROWSER_LAUNCH_COOLDOWN_MS -as [int]) {
  $CooldownMs = [int]$env:GEMINI_MCP_BROWSER_LAUNCH_COOLDOWN_MS
}

function Get-NowMs {
  return [int64](([DateTime]::UtcNow - [DateTime]'1970-01-01T00:00:00Z').TotalMilliseconds)
}

function Get-StatePath {
  $root = $env:TEMP
  if ([string]::IsNullOrWhiteSpace($root)) {
    $root = [System.IO.Path]::GetTempPath()
  }
  return (Join-Path (Join-Path $root 'gemini-md-export') 'hook-browser-launch.json')
}

function Read-LaunchState {
  $path = Get-StatePath
  if (-not (Test-Path -LiteralPath $path)) {
    return $null
  }
  try {
    return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Write-LaunchState($state) {
  try {
    $path = Get-StatePath
    $dir = Split-Path -Parent $path
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    ($state | ConvertTo-Json -Compress -Depth 5) | Set-Content -LiteralPath $path -Encoding UTF8
  } catch {
  }
}

function Test-BridgeHasClient {
  try {
    $request = [System.Net.WebRequest]::Create($BridgeClientsUrl)
    $request.Method = 'GET'
    $request.Timeout = $BridgeTimeoutMs
    $request.ReadWriteTimeout = $BridgeTimeoutMs
    $response = $request.GetResponse()
    try {
      $stream = $response.GetResponseStream()
      $reader = New-Object System.IO.StreamReader($stream)
      $json = $reader.ReadToEnd()
      if ([string]::IsNullOrWhiteSpace($json)) {
        return $false
      }
      $payload = $json | ConvertFrom-Json
      return ($payload.connectedClients -and $payload.connectedClients.Count -gt 0)
    } finally {
      if ($reader) { $reader.Dispose() }
      if ($response) { $response.Dispose() }
    }
  } catch {
    return $false
  }
}

function Normalize-BrowserKey($value) {
  $text = [string]$value
  $text = $text.Trim().ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($text)) { return 'chrome' }
  if ($text -match '^(google[-_\s]*)?chrome$|chrome\.exe$') { return 'chrome' }
  if ($text -match '^edge$|microsoft[-_\s]*edge|msedge(\.exe)?$') { return 'edge' }
  if ($text -match '^brave$|brave[-_\s]*browser|brave(\.exe)?$') { return 'brave' }
  if ($text -match '^dia$|dia(\.exe)?$') { return 'dia' }
  return $text
}

function Get-BrowserOrder($preferred) {
  $order = New-Object System.Collections.Generic.List[string]
  $order.Add($preferred)
  foreach ($candidate in @('chrome', 'edge', 'brave', 'dia')) {
    if ($candidate -ne $preferred) {
      $order.Add($candidate)
    }
  }
  return $order
}

function Get-CandidatesForBrowser($browserKey) {
  $localAppData = $env:LOCALAPPDATA
  $programFiles = if ($env:ProgramFiles) { $env:ProgramFiles } else { 'C:\Program Files' }
  $programFilesX86Env = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $programFilesX86 = if ($programFilesX86Env) { $programFilesX86Env } else { 'C:\Program Files (x86)' }

  switch ($browserKey) {
    'edge' {
      return @(
        $env:GEMINI_MCP_EDGE_EXE,
        $env:GME_EDGE_EXE,
        $(if ($localAppData) { Join-Path $localAppData 'Microsoft\Edge\Application\msedge.exe' }),
        (Join-Path $programFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $programFilesX86 'Microsoft\Edge\Application\msedge.exe')
      )
    }
    'brave' {
      return @(
        $env:GEMINI_MCP_BRAVE_EXE,
        $env:GME_BRAVE_EXE,
        $(if ($localAppData) { Join-Path $localAppData 'BraveSoftware\Brave-Browser\Application\brave.exe' }),
        (Join-Path $programFiles 'BraveSoftware\Brave-Browser\Application\brave.exe'),
        (Join-Path $programFilesX86 'BraveSoftware\Brave-Browser\Application\brave.exe')
      )
    }
    'dia' {
      return @(
        $env:GEMINI_MCP_DIA_EXE,
        $env:GME_DIA_EXE,
        $(if ($localAppData) { Join-Path $localAppData 'Programs\Dia\Dia.exe' }),
        $(if ($env:APPDATA) { Join-Path $env:APPDATA 'Dia\Application\Dia.exe' })
      )
    }
    default {
      return @(
        $env:GEMINI_MCP_CHROME_EXE,
        $env:GME_CHROME_EXE,
        $(if ($localAppData) { Join-Path $localAppData 'Google\Chrome\Application\chrome.exe' }),
        (Join-Path $programFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $programFilesX86 'Google\Chrome\Application\chrome.exe')
      )
    }
  }
}

function Get-BrowserAlias($browserKey) {
  switch ($browserKey) {
    'edge' { return 'msedge.exe' }
    'brave' { return 'brave.exe' }
    'dia' { return 'dia.exe' }
    default { return 'chrome.exe' }
  }
}

function Resolve-BrowserCommand {
  $requestedBrowser = if ($env:GEMINI_MCP_BROWSER) { $env:GEMINI_MCP_BROWSER } else { $env:GME_BROWSER }
  $preferred = Normalize-BrowserKey $requestedBrowser
  foreach ($browserKey in (Get-BrowserOrder $preferred)) {
    foreach ($candidate in (Get-CandidatesForBrowser $browserKey)) {
      if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate)) {
        return @{ BrowserKey = $browserKey; Command = $candidate; Source = 'filesystem' }
      }
    }

    $alias = Get-BrowserAlias $browserKey
    $resolved = Get-Command $alias -ErrorAction SilentlyContinue
    if ($resolved -and $resolved.Source) {
      return @{ BrowserKey = $browserKey; Command = $resolved.Source; Source = 'path' }
    }
  }

  return @{ BrowserKey = $preferred; Command = (Get-BrowserAlias $preferred); Source = 'alias' }
}

function Start-GeminiBrowser {
  $browser = Resolve-BrowserCommand
  $args = New-Object System.Collections.Generic.List[string]
  $profile = if ($env:GEMINI_MCP_CHROME_PROFILE_DIRECTORY) {
    $env:GEMINI_MCP_CHROME_PROFILE_DIRECTORY
  } else {
    $env:GME_CHROME_PROFILE_DIRECTORY
  }
  if (-not [string]::IsNullOrWhiteSpace($profile)) {
    $args.Add("--profile-directory=$profile")
  }
  $args.Add('--new-tab')
  $args.Add($GeminiUrl)

  try {
    $quotedArgs = ($args.ToArray() | ForEach-Object { '"' + ($_ -replace '"', '""') + '"' }) -join ' '
    $cmdLine = 'start "" "{0}" {1}' -f ($browser.Command -replace '"', '""'), $quotedArgs
    Start-Process -FilePath "$env:ComSpec" -ArgumentList @('/d', '/s', '/c', $cmdLine) -WindowStyle Hidden -ErrorAction Stop
    Write-LaunchState @{
      lastAttemptAt = Get-NowMs
      browserKey = $browser.BrowserKey
      command = $browser.Command
      source = $browser.Source
      method = 'cmd-start'
    }
  } catch {
    $cmdStartError = $_.Exception.Message
    try {
      Start-Process -FilePath $browser.Command -ArgumentList $args.ToArray() -WindowStyle Minimized -ErrorAction Stop
      Write-LaunchState @{
        lastAttemptAt = Get-NowMs
        browserKey = $browser.BrowserKey
        command = $browser.Command
        source = $browser.Source
        method = 'Start-Process'
        cmdStartError = $cmdStartError
      }
    } catch {
      Write-LaunchState @{
        lastFailureAt = Get-NowMs
        browserKey = $browser.BrowserKey
        command = $browser.Command
        source = $browser.Source
        method = 'failed'
        error = $_.Exception.Message
        cmdStartError = $cmdStartError
      }
    }
  }
}

try {
  if (Test-BridgeHasClient) {
    Write-LaunchState @{ lastConnectedAt = Get-NowMs; method = 'bridge-connected' }
    exit 0
  }

  $state = Read-LaunchState
  $lastAttemptAt = 0
  if ($state -and $state.lastAttemptAt) {
    $lastAttemptAt = [int64]$state.lastAttemptAt
  }
  if ($CooldownMs -gt 0 -and $lastAttemptAt -gt 0 -and ((Get-NowMs) - $lastAttemptAt) -lt $CooldownMs) {
    exit 0
  }

  Start-GeminiBrowser
} catch {
  Write-LaunchState @{ lastAttemptAt = Get-NowMs; method = 'unexpected-failure'; error = $_.Exception.Message }
}
