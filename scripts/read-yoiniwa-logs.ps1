# Read Yoiniwa diagnostic logs (workspace mirror + AppData).
$ErrorActionPreference = 'SilentlyContinue'
$mirror = Join-Path $PSScriptRoot '..\.dev-runtime\yoiniwa.jsonl'
$appData = Join-Path $env:APPDATA 'Yoiniwa\logs\yoiniwa.jsonl'
$path = if (Test-Path $mirror) { $mirror } elseif (Test-Path $appData) { $appData } else { $null }
if (-not $path) {
  Write-Host 'No Yoiniwa log file found yet. Start the app once, then retry.'
  Write-Host "Expected mirror: $mirror"
  Write-Host "Expected appdata: $appData"
  exit 1
}
Write-Host "Log: $path"
$tail = if ($args.Count -gt 0) { [int]$args[0] } else { 80 }
Get-Content $path -Tail $tail
Write-Host ''
Write-Host '--- recent warn/error ---'
Get-Content $path | Where-Object { $_ -match '"level":"(warn|error)"' } | Select-Object -Last 40
