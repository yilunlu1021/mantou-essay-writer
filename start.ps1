$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'Install Node.js 22 or 24 LTS from https://nodejs.org/en/download, reopen PowerShell, then retry.'
  exit 1
}
& node bin/essay.mjs doctor
exit $LASTEXITCODE
