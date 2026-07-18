$ErrorActionPreference = 'Stop'
$repo = 'https://github.com/ghanavati/relay.git'
$prefix = Join-Path $env:LOCALAPPDATA 'Relay'
$bin = Join-Path $env:LOCALAPPDATA 'Relay\bin'

foreach ($command in @('git', 'node', 'npm')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is required. Install it, then run this command again." }
}
if ([int](node -p "process.versions.node.split('.')[0]") -lt 20) { throw 'Node 20 or newer is required.' }

if (Test-Path (Join-Path $prefix '.git')) {
  git -C $prefix fetch --quiet origin
  git -C $prefix reset --quiet --hard origin/HEAD
} elseif (Test-Path $prefix) {
  throw "$prefix exists but is not a Relay installation. Move it, then try again."
} else {
  git clone --depth 1 $repo $prefix
}

Push-Location $prefix
npm install --silent
npm run build --silent
Pop-Location
New-Item -ItemType Directory -Force -Path $bin | Out-Null
Set-Content (Join-Path $bin 'relay.cmd') "@echo off`r`nnode `"$prefix\dist\cli.js`" %*"
[Environment]::SetEnvironmentVariable('Path', $env:Path + ";$bin", 'User')
& (Join-Path $bin 'relay.cmd') setup --everything --yes
Write-Host 'Relay is installed. Open a new terminal and run: relay --help'
