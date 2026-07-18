$ErrorActionPreference = 'Stop'
$repo = 'ghanavati/relay'
$arch = if ([Environment]::Is64BitOperatingSystem) { 'windows-x64' } else { throw 'Relay requires 64-bit Windows.' }
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=20"
$asset = $release.assets | Where-Object { $_.name -match "-$arch\.zip$" } | Select-Object -First 1
if (-not $asset) { throw "No Relay release is available for $arch." }
$tag = $asset.name -replace '^relay-v', '' -replace "-$arch\.zip$", ''
$root = Join-Path $env:LOCALAPPDATA 'Relay'
$work = Join-Path $env:TEMP "relay-$tag"
New-Item -ItemType Directory -Force -Path $work, $root | Out-Null
$zip = Join-Path $work $asset.name
Invoke-WebRequest $asset.browser_download_url -OutFile $zip
Invoke-WebRequest "https://github.com/$repo/releases/download/v$tag/SHA256SUMS.txt" -OutFile (Join-Path $work 'SHA256SUMS.txt')
$expected = (Get-Content (Join-Path $work 'SHA256SUMS.txt') | Where-Object { $_ -match [regex]::Escape($asset.name) }).Split()[0]
if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $expected.ToLower()) { throw 'Checksum verification failed.' }
Expand-Archive $zip -DestinationPath $root -Force
$relayDir = Join-Path $root ($asset.name -replace '\.zip$', '')
$bin = Join-Path $env:LOCALAPPDATA 'Relay\bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
Set-Content (Join-Path $bin 'relay.cmd') "@echo off`r`n`"$relayDir\runtime\node.exe`" `"$relayDir\app\dist\cli.js`" %*"
[Environment]::SetEnvironmentVariable('Path', $env:Path + ";$bin", 'User')
Write-Host "Relay $tag installed. Open a new terminal, then run: relay setup --everything"
