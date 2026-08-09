
$ErrorActionPreference = 'Stop'
$photoshop = $null
$color = $null
$rgb = $null
$directColor = $true
function Reset-Photoshop {
  $script:photoshop = $null; $script:color = $null; $script:rgb = $null; $script:directColor = $true
}
function Ensure-Photoshop {
  if ($null -ne $photoshop) { return $true }
  try {
    $script:photoshop = [Runtime.InteropServices.Marshal]::GetActiveObject('Photoshop.Application')
    $script:color = $photoshop.ForegroundColor
    $script:rgb = $color.RGB
    $script:directColor = $true
    return $true
  } catch { Reset-Photoshop; return $false }
}
function Color-Matches([int]$r, [int]$g, [int]$b) {
  try {
    $current = $photoshop.ForegroundColor.RGB
    return ([Math]::Abs([double]$current.Red - $r) -lt 0.75 -and [Math]::Abs([double]$current.Green - $g) -lt 0.75 -and [Math]::Abs([double]$current.Blue - $b) -lt 0.75)
  } catch { return $false }
}
function Set-PhotoshopColor([int]$r, [int]$g, [int]$b) {
  try {
    if ($directColor) {
      try {
        $rgb.Red = $r; $rgb.Green = $g; $rgb.Blue = $b
        $color.RGB = $rgb
        $photoshop.ForegroundColor = $color
        if (Color-Matches $r $g $b) { return 'SYNCED' }
      } catch {}
      $script:directColor = $false
    }
    $jsx = 'var c=new SolidColor();c.rgb.red=' + $r + ';c.rgb.green=' + $g + ';c.rgb.blue=' + $b + ';app.foregroundColor=c;'
    $null = $photoshop.DoJavaScript($jsx)
    if (Color-Matches $r $g $b) { return 'SYNCED' }
    return 'SYNC_ERROR'
  } catch { Reset-Photoshop; return 'SYNC_ERROR' }
}
$null = Ensure-Photoshop
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $parts = $line.Split('|')
  if ($parts.Length -lt 2) { continue }
  $kind = $parts[0]; $id = $parts[1]
  try {
    if (-not (Ensure-Photoshop)) {
      [Console]::Out.WriteLine($id + '|NOT_RUNNING|SKIPPED'); [Console]::Out.Flush(); continue
    }
    if ($kind -eq 'W') {
      [Console]::Out.WriteLine($id + '|SYNCED|SKIPPED'); [Console]::Out.Flush(); continue
    }
    if ($kind -ne 'S' -or $parts.Length -ne 5) { continue }
    $syncStatus = Set-PhotoshopColor ([int]$parts[2]) ([int]$parts[3]) ([int]$parts[4])
    [Console]::Out.WriteLine($id + '|' + $syncStatus + '|SKIPPED'); [Console]::Out.Flush()
  } catch {
    Reset-Photoshop
    [Console]::Out.WriteLine($id + '|SYNC_ERROR|SKIPPED'); [Console]::Out.Flush()
  }
}
