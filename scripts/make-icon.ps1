Add-Type -AssemblyName System.Drawing

# SquizanTV: marca minimalista y calida.
# Cuadrado redondeado casi negro + "S" crema de trazo humano + play rojo + punto dorado.
# Ejecutar desde la raiz del proyecto: powershell -ExecutionPolicy Bypass -File scripts/make-icon.ps1

$size = 512
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

# --- Fondo: cuadrado redondeado con degradado calido ---
$inset = 10
$r = 106
$bg = New-Object System.Drawing.Drawing2D.GraphicsPath
$bg.AddArc($inset, $inset, $r * 2, $r * 2, 180, 90)
$bg.AddArc($size - $inset - $r * 2, $inset, $r * 2, $r * 2, 270, 90)
$bg.AddArc($size - $inset - $r * 2, $size - $inset - $r * 2, $r * 2, $r * 2, 0, 90)
$bg.AddArc($inset, $size - $inset - $r * 2, $r * 2, $r * 2, 90, 90)
$bg.CloseFigure()

$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(60, 20)),
  (New-Object System.Drawing.Point(460, 500)),
  [System.Drawing.Color]::FromArgb(255, 30, 25, 23),
  [System.Drawing.Color]::FromArgb(255, 8, 8, 10)
)
$g.FillPath($bgBrush, $bg)

# Halo calido muy sutil arriba a la izquierda (da profundidad, no ruido).
$glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowPath.AddEllipse(18, 8, 330, 330)
$glow = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowPath)
$glow.CenterColor = [System.Drawing.Color]::FromArgb(36, 229, 9, 20)
$glow.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 229, 9, 20))
$g.FillPath($glow, $glowPath)

# --- Paleta ---
$cream = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 246, 239, 228))
$red = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 229, 9, 20))
$gold = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 184, 0))

# --- "S" crema: trazo grueso con extremos redondeados ---
$pen = New-Object System.Drawing.Pen($cream, 42)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$s = New-Object System.Drawing.Drawing2D.GraphicsPath
$s.AddBezier(294, 150, 294, 118, 264, 98, 226, 98)
$s.AddBezier(226, 98, 176, 98, 145, 130, 145, 170)
$s.AddBezier(145, 170, 145, 218, 190, 234, 234, 246)
$s.AddBezier(234, 246, 284, 259, 320, 278, 320, 322)
$s.AddBezier(320, 322, 320, 362, 282, 390, 232, 390)
$s.AddBezier(232, 390, 184, 390, 151, 367, 145, 333)
$g.DrawPath($pen, $s)

# --- Play rojo con esquinas suaves ---
$play = New-Object System.Drawing.Drawing2D.GraphicsPath
$play.AddPolygon(@(
  (New-Object System.Drawing.PointF(348, 212)),
  (New-Object System.Drawing.PointF(348, 308)),
  (New-Object System.Drawing.PointF(416, 260))
))
$playPen = New-Object System.Drawing.Pen($red, 14)
$playPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$g.FillPath($red, $play)
$g.DrawPath($playPen, $play)

# --- Punto dorado: el detalle humano de la marca ---
$g.FillEllipse($gold, 354, 146, 16, 16)

# Limpieza
$pen.Dispose(); $playPen.Dispose(); $s.Dispose(); $play.Dispose(); $bg.Dispose(); $glowPath.Dispose()
$cream.Dispose(); $red.Dispose(); $gold.Dispose(); $bgBrush.Dispose(); $glow.Dispose()
$g.Dispose()

$out = Join-Path (Split-Path -Parent $PSScriptRoot) 'build/icon.png'
if (-not (Test-Path (Split-Path -Parent $out))) { New-Item -ItemType Directory -Path (Split-Path -Parent $out) | Out-Null }
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output $out
