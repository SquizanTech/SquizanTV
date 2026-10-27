Add-Type -AssemblyName System.Drawing

$size = 512
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

$r = 112
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
$path.AddArc($size - $r * 2, 0, $r * 2, $r * 2, 270, 90)
$path.AddArc($size - $r * 2, $size - $r * 2, $r * 2, $r * 2, 0, 90)
$path.AddArc(0, $size - $r * 2, $r * 2, $r * 2, 90, 90)
$path.CloseFigure()

$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)),
  (New-Object System.Drawing.Point($size, $size)),
  [System.Drawing.Color]::FromArgb(255, 139, 107, 255),
  [System.Drawing.Color]::FromArgb(255, 34, 211, 238)
)
$g.FillPath($brush, $path)

$glow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(38, 255, 255, 255))
$g.FillEllipse($glow, 40, 20, 360, 360)

$points = @(
  (New-Object System.Drawing.PointF(196, 156)),
  (New-Object System.Drawing.PointF(196, 356)),
  (New-Object System.Drawing.PointF(376, 256))
)
$g.FillPolygon([System.Drawing.Brushes]::White, $points)

$shadow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(46, 0, 0, 0))
$g.FillEllipse($shadow, 90, 400, 332, 60)

$g.Dispose()
$dir = Join-Path $PSScriptRoot '..\build'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$bmp.Save((Join-Path $dir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "Icono generado en build\icon.png"
