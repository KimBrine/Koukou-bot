param([string]$listFile)
Add-Type -AssemblyName System.Drawing
$files = Get-Content -LiteralPath $listFile -Raw | ConvertFrom-Json
$out = @()
foreach ($f in $files) {
  try {
    $img = [System.Drawing.Image]::FromFile($f)
    $bmp = New-Object System.Drawing.Bitmap 9, 8
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, 9, 8)
    $g.Dispose()
    $bits = New-Object System.Text.StringBuilder
    for ($y = 0; $y -lt 8; $y++) {
      for ($x = 0; $x -lt 8; $x++) {
        $c1 = $bmp.GetPixel($x, $y); $c2 = $bmp.GetPixel($x + 1, $y)
        $l1 = 0.299 * $c1.R + 0.587 * $c1.G + 0.114 * $c1.B
        $l2 = 0.299 * $c2.R + 0.587 * $c2.G + 0.114 * $c2.B
        if ($l1 -lt $l2) { [void]$bits.Append('1') } else { [void]$bits.Append('0') }
      }
    }
    $out += [pscustomobject]@{ file = $f; hash = $bits.ToString() }
    $bmp.Dispose(); $img.Dispose()
  } catch { $out += [pscustomobject]@{ file = $f; hash = '' } }
}
$out | ConvertTo-Json -Compress
