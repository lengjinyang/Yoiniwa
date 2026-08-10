# Read Yoiniwa diagnostic logs (workspace mirror + AppData).
$ErrorActionPreference = 'SilentlyContinue'
$candidates = @(
  (Join-Path $PSScriptRoot '..\.dev-runtime\yoiniwa.jsonl'),
  (Join-Path $env:APPDATA 'Yoiniwa\logs\yoiniwa.jsonl')
) + @(Get-ChildItem (Join-Path $env:APPDATA 'Yoiniwa\logs\yoiniwa-*.jsonl') | Sort-Object LastWriteTime -Descending | Select-Object -ExpandProperty FullName)
$path = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $path) {
  Write-Host 'No Yoiniwa log file found yet. Start the app once, then retry.'
  $candidates | ForEach-Object { Write-Host "Checked: $_" }
  exit 1
}
Write-Host "Log: $path"
$tail = if ($args.Count -gt 0) { [int]$args[0] } else { 80 }
Get-Content $path -Tail $tail
Write-Host ''
Write-Host '--- recent warn/error / photoshop ---'
Get-Content $path | Where-Object {
  $_ -match '"level":"(warn|error)"' -or $_ -match 'photoshop|collaboration|automation'
} | Select-Object -Last 40
