param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $true)][string]$PidFile,
  [string]$Url = 'http://127.0.0.1:3080/',
  [switch]$StartExpanded
)

$ErrorActionPreference = 'Stop'
trap { try { Set-Content -LiteralPath (Join-Path $Dir 'desktop.error') -Value ($_ | Out-String) -Encoding UTF8 } catch { }; break }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# Must run before the first control exists, or WinForms refuses the change.
try { [System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException) } catch { }
try {
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class KbDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
}
'@
  [KbDpi]::SetProcessDPIAware() | Out-Null
} catch { }

$script:Dir = $Dir
$script:ReqDir = Join-Path $Dir 'dreq'
$script:ResDir = Join-Path $Dir 'dres'
$script:Url = $Url
New-Item -ItemType Directory -Force -Path $script:ReqDir | Out-Null
New-Item -ItemType Directory -Force -Path $script:ResDir | Out-Null

$script:scale = 1.0
try {
  [System.Windows.Forms.Application]::SetHighDpiMode([System.Windows.Forms.HighDpiMode]::PerMonitorV2) | Out-Null
  $script:scale = [KbDpi]::GetDpiForSystem() / 96.0
} catch { $script:scale = 1.0 }
function S([double]$v) { return [int][Math]::Round($v * $script:scale) }

$WIDE = S 118
$NARROW = S 22
$PILL_H = S 40
$PANEL_W = S 400
$PANEL_H = S 584

# ── palette ──────────────────────────────────────────────────────────────────
function C([int]$r, [int]$g, [int]$b) { return [System.Drawing.Color]::FromArgb($r, $g, $b) }
$colBg = C 255 255 255
$colBorder = C 229 232 236
$colDivider = C 240 242 245
$colText = C 22 24 29
$colMuted = C 139 147 161
$colFaint = C 244 246 248
$colHover = C 240 243 247
$colAccent = C 59 130 246
$colAccentDeep = C 37 99 235
$colAccentSoft = C 239 246 255
$colCard = C 249 250 252

$script:expanded = $false
$script:edge = $null
$script:flash = ''
$script:dragging = $false
$script:moved = $false
$script:dragStart = [System.Drawing.Point]::new(0, 0)
$script:formStart = [System.Drawing.Point]::new(0, 0)
$script:pillPlace = [System.Drawing.Point]::new(0, 0)
$script:reqSeq = 0
$script:resultItems = @()
$script:fileItems = @()
$script:docCount = 0
$script:chunkCount = 0
$script:dim = 512
$script:removeArmed = $false
$script:closeHot = $false
$script:filesHot = -1
$script:resultsHot = -1
$script:lastStateAt = [DateTime]::MinValue
$script:rectClose = [System.Drawing.Rectangle]::new(0, 0, 0, 0)
$script:rectRemove = [System.Drawing.Rectangle]::new(0, 0, 0, 0)

$fontTitle = New-Object System.Drawing.Font('Microsoft YaHei UI', 11)
$fontText = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5)
$fontSmall = New-Object System.Drawing.Font('Microsoft YaHei UI', 8.5)
$fontTiny = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)
$fontGlyph = New-Object System.Drawing.Font('Segoe MDL2 Assets', 11)
$fontArrow = New-Object System.Drawing.Font('Segoe UI Symbol', 11)
$fontCaret = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)

$brushText = New-Object System.Drawing.SolidBrush $colText
$brushMuted = New-Object System.Drawing.SolidBrush $colMuted
$brushAccent = New-Object System.Drawing.SolidBrush $colAccent
$brushWhite = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$brushCard = New-Object System.Drawing.SolidBrush $colCard
$brushFaint = New-Object System.Drawing.SolidBrush $colFaint
$brushHover = New-Object System.Drawing.SolidBrush $colHover
$brushAccentSoft = New-Object System.Drawing.SolidBrush $colAccentSoft
$penBorder = New-Object System.Drawing.Pen $colBorder, 1
$penDivider = New-Object System.Drawing.Pen $colDivider, 1
$fmtTrim = New-Object System.Drawing.StringFormat
$fmtTrim.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
$fmtTrim.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
$fmtFar = New-Object System.Drawing.StringFormat
$fmtFar.Alignment = [System.Drawing.StringAlignment]::Far
$fmtFar.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
$fmtFar.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
$fmtCenter = New-Object System.Drawing.StringFormat
$fmtCenter.Alignment = [System.Drawing.StringAlignment]::Center
$fmtCenter.LineAlignment = [System.Drawing.StringAlignment]::Center

function New-RoundPath([int]$w, [int]$h, [int]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  if ($r -lt 2) { $r = 2 }
  $d = $r * 2
  if ($d -gt $w) { $d = $w }
  if ($d -gt $h) { $d = $h }
  $path.AddArc(1, 1, $d, $d, 180, 90)
  $path.AddArc($w - $d - 1, 1, $d, $d, 270, 90)
  $path.AddArc($w - $d - 1, $h - $d - 1, $d, $d, 0, 90)
  $path.AddArc(1, $h - $d - 1, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function Set-Round($control, [int]$radius) {
  $path = New-RoundPath $control.Width $control.Height $radius
  $old = $control.Region
  $control.Region = [System.Drawing.Region]::new($path)
  if ($old -ne $null) { $old.Dispose() }
}

# ── shell ────────────────────────────────────────────────────────────────────
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = $colBg
$form.AutoScaleMode = 'None'
$form.Size = [System.Drawing.Size]::new($WIDE, $PILL_H)
$form.Text = '知识库'
$form.AllowDrop = $true

# Search field: a rounded grey pill hosting a chrome-less text box.
$searchHost = New-Object System.Windows.Forms.Panel
$searchHost.BackColor = $colFaint
$searchHost.Visible = $false
$search = New-Object System.Windows.Forms.TextBox
$search.BorderStyle = 'None'
$search.BackColor = $colFaint
$search.ForeColor = $colText
$search.Font = $fontText
$searchHost.Controls.Add($search)

$goBtn = New-Object System.Windows.Forms.Button
$goBtn.Text = '检索'
$goBtn.Font = $fontText
$goBtn.FlatStyle = 'Flat'
$goBtn.BackColor = $colAccent
$goBtn.ForeColor = [System.Drawing.Color]::White
$goBtn.FlatAppearance.BorderSize = 0
$goBtn.FlatAppearance.MouseOverBackColor = $colAccentDeep
$goBtn.FlatAppearance.MouseDownBackColor = $colAccentDeep
$goBtn.Cursor = 'Hand'
$goBtn.Visible = $false

$results = New-Object System.Windows.Forms.ListBox
$results.BorderStyle = 'None'
$results.BackColor = $colBg
$results.DrawMode = 'OwnerDrawFixed'
$results.ItemHeight = S 62
$results.IntegralHeight = $false
$results.Visible = $false

$files = New-Object System.Windows.Forms.ListBox
$files.BorderStyle = 'None'
$files.BackColor = $colBg
$files.DrawMode = 'OwnerDrawFixed'
$files.ItemHeight = S 42
$files.IntegralHeight = $false
$files.Visible = $false

$removeBtn = New-Object System.Windows.Forms.Button
$removeBtn.Text = '移除'
$removeBtn.Font = $fontSmall
$removeBtn.FlatStyle = 'Flat'
$removeBtn.BackColor = $colBg
$removeBtn.ForeColor = $colMuted
$removeBtn.FlatAppearance.BorderSize = 0
$removeBtn.FlatAppearance.MouseOverBackColor = $colHover
$removeBtn.Cursor = 'Hand'
$removeBtn.Visible = $false

$form.Controls.AddRange(@($searchHost, $goBtn, $results, $files, $removeBtn))

function Set-Shape {
  $radius = S 18
  if ($script:expanded) { $radius = S 14 }
  $path = New-RoundPath $form.Width $form.Height $radius
  $old = $form.Region
  $form.Region = [System.Drawing.Region]::new($path)
  if ($old -ne $null) { $old.Dispose() }
  $form.Invalidate()
}

function Save-Place {
  try {
    $value = ('' + $form.Left + ',' + $form.Top + ',' + $script:edge + ',' + $script:expanded)
    Set-Content -LiteralPath (Join-Path $script:Dir 'desktop.pos') -Value $value -Encoding ASCII
  } catch { }
}

# ── host bridge ──────────────────────────────────────────────────────────────
function Send-Request([string]$op, $extra) {
  $script:reqSeq = $script:reqSeq + 1
  $id = ([DateTime]::UtcNow.Ticks.ToString('d18')) + '-' + $script:reqSeq
  $obj = @{ id = $id; op = $op }
  if ($extra) { foreach ($key in $extra.Keys) { $obj[$key] = $extra[$key] } }
  try {
    [System.IO.File]::WriteAllText((Join-Path $script:ReqDir ($id + '.json')), ($obj | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))
  } catch { }
  return $id
}

$flashTimer = New-Object System.Windows.Forms.Timer
$flashTimer.Interval = 2500
$flashTimer.Add_Tick({ $flashTimer.Stop(); $script:flash = ''; $form.Invalidate() })

function Set-Flash([string]$text) {
  $script:flash = $text
  $form.Invalidate()
  $flashTimer.Stop()
  $flashTimer.Start()
}

function Apply-State($data) {
  $script:docCount = [int]$data.docCount
  $script:chunkCount = [int]$data.chunkCount
  $script:dim = [int]$data.dim
  $script:fileItems = @($data.docs)
  $files.Visible = $script:expanded -and $script:fileItems.Count -gt 0
  $removeBtn.Visible = $script:expanded -and $script:fileItems.Count -gt 0
  $files.Items.Clear()
  foreach ($doc in $script:fileItems) { $files.Items.Add([string]$doc.name) | Out-Null }
  $form.Invalidate()
}

function Apply-Results($data) {
  $script:resultItems = @($data.results)
  $results.Items.Clear()
  foreach ($item in $script:resultItems) { $results.Items.Add([string]$item.file) | Out-Null }
  $results.Visible = $script:expanded -and $script:resultItems.Count -gt 0
  $form.Invalidate()
}

function Handle-Response($msg) {
  $op = [string]$msg.op
  if ($op -eq 'state') {
    if ($msg.ok) { Apply-State $msg } else { Set-Flash '本地知识库插件未运行' }
  }
  elseif ($op -eq 'search') {
    if ($msg.ok) { Apply-Results $msg } else { Set-Flash '检索失败' }
  }
  elseif ($op -eq 'ingest') {
    if ($msg.ok) { Set-Flash ('已入库 ' + [string]$msg.chunks + ' 个片段') } else { Set-Flash ('入库失败：' + [string]$msg.error) }
    Send-Request 'state' $null | Out-Null
  }
  elseif ($op -eq 'remove') {
    $script:removeArmed = $false
    $removeBtn.Text = '移除'
    $removeBtn.ForeColor = $colMuted
    Send-Request 'state' $null | Out-Null
  }
}

function Poll-Responses {
  $entries = @()
  try { $entries = @(Get-ChildItem -LiteralPath $script:ResDir -Filter '*.json' -ErrorAction SilentlyContinue) } catch { }
  foreach ($entry in $entries) {
    $text = ''
    try { $text = [System.IO.File]::ReadAllText($entry.FullName, [System.Text.Encoding]::UTF8) } catch { continue }
    Remove-Item -LiteralPath $entry.FullName -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $script:ReqDir $entry.Name) -Force -ErrorAction SilentlyContinue
    try { Handle-Response ($text | ConvertFrom-Json) } catch { }
  }
  if ($script:expanded -and ((Get-Date) - $script:lastStateAt).TotalSeconds -gt 6) {
    $script:lastStateAt = Get-Date
    Send-Request 'state' $null | Out-Null
  }
}

# ── layout ───────────────────────────────────────────────────────────────────
function Layout-Panel {
  $pad = S 16
  $gap = S 8
  $btnW = S 64
  $inputW = $form.Width - ($pad * 2) - $btnW - $gap
  $searchHost.Location = [System.Drawing.Point]::new($pad, (S 72))
  $searchHost.Size = [System.Drawing.Size]::new($inputW, (S 38))
  Set-Round $searchHost (S 19)
  $search.Location = [System.Drawing.Point]::new((S 14), (S 10))
  $search.Size = [System.Drawing.Size]::new(($inputW - (S 28)), (S 20))
  $goBtn.Location = [System.Drawing.Point]::new(($pad + $inputW + $gap), (S 72))
  $goBtn.Size = [System.Drawing.Size]::new($btnW, (S 38))
  Set-Round $goBtn (S 19)

  $resultsTop = S 144
  $filesTop = $form.Height - (S 240)
  $results.Location = [System.Drawing.Point]::new((S 8), $resultsTop)
  $results.Size = [System.Drawing.Size]::new(($form.Width - (S 16)), ($filesTop - (S 40) - $resultsTop))

  $removeBtn.Location = [System.Drawing.Point]::new(($form.Width - $pad - (S 62)), ($filesTop - (S 30)))
  $removeBtn.Size = [System.Drawing.Size]::new((S 62), (S 24))
  Set-Round $removeBtn (S 8)
  $files.Location = [System.Drawing.Point]::new((S 8), $filesTop)
  $files.Size = [System.Drawing.Size]::new(($form.Width - (S 16)), (S 176))
  $script:rectRemove = [System.Drawing.Rectangle]::new($removeBtn.Left, $removeBtn.Top, $removeBtn.Width, $removeBtn.Height)
}

function Set-Expanded([bool]$value) {
  if ($value -eq $script:expanded) { return }
  $script:expanded = $value
  $searchHost.Visible = $value
  $goBtn.Visible = $value
  $files.Visible = $value -and $script:fileItems.Count -gt 0
  $removeBtn.Visible = $value -and $script:fileItems.Count -gt 0
  $results.Visible = $value -and $script:resultItems.Count -gt 0
  $script:removeArmed = $false
  $removeBtn.Text = '移除'
  $removeBtn.ForeColor = $colMuted
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  if ($value) {
    $script:pillPlace = $form.Location
    $script:edge = $null
    $height = [Math]::Min($PANEL_H, ($wa.Height - (S 24)))
    $form.Size = [System.Drawing.Size]::new($PANEL_W, $height)
    $form.Left = [Math]::Max(($wa.Left + (S 8)), [Math]::Min($script:pillPlace.X, ($wa.Right - $form.Width - (S 8))))
    $form.Top = [Math]::Max(($wa.Top + (S 8)), [Math]::Min($script:pillPlace.Y, ($wa.Bottom - $form.Height - (S 8))))
    Layout-Panel
    $script:lastStateAt = [DateTime]::MinValue
    Send-Request 'state' $null | Out-Null
  }
  else {
    $form.Size = [System.Drawing.Size]::new($WIDE, $PILL_H)
    $form.Location = $script:pillPlace
  }
  Set-Shape
  Save-Place
}

# ── painting ─────────────────────────────────────────────────────────────────
$form.Add_Paint({
    param($sender, $e)
    $g = $e.Graphics
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $radius = S 18
    if ($script:expanded) { $radius = S 14 }
    $g.DrawPath($penBorder, (New-RoundPath $sender.Width $sender.Height $radius))
    $mid = [int]($sender.Height / 2)
    $pad = S 16

    if (-not $script:expanded) {
      if ($script:flash -ne '') {
        $g.DrawString($script:flash, $fontSmall, $brushAccent, (S 10), ($mid - (S 9)))
      }
      else {
        $g.DrawString([string][char]0x2193, $fontArrow, $brushAccent, (S 10), ($mid - (S 11)))
        $g.DrawString('知识库', $fontText, $brushText, (S 30), ($mid - (S 10)))
      }
      return
    }

    # header: accent badge, title, close
    $badge = [System.Drawing.Rectangle]::new($pad, (S 14), (S 28), (S 28))
    $badgePath = New-RoundPath $badge.Width $badge.Height (S 9)
    $badgeState = $g.Save()
    $g.TranslateTransform($badge.X, $badge.Y)
    $g.FillPath($brushAccent, $badgePath)
    $g.Restore($badgeState)
    $penWhite = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), (S 2)
    $penWhite.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $penWhite.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $bx = $badge.X + [int]($badge.Width / 2)
    $by = $badge.Y + [int]($badge.Height / 2)
    $g.DrawLine($penWhite, $bx, ($by - (S 6)), $bx, ($by + (S 5)))
    $g.DrawLine($penWhite, ($bx - (S 4)), ($by + (S 1)), $bx, ($by + (S 5)))
    $g.DrawLine($penWhite, ($bx + (S 4)), ($by + (S 1)), $bx, ($by + (S 5)))
    $g.DrawString('知识库', $fontTitle, $brushText, ($pad + (S 38)), (S 17))

    $script:rectClose = [System.Drawing.Rectangle]::new(($sender.Width - $pad - (S 28)), (S 14), (S 28), (S 28))
    if ($script:closeHot) {
      $closePath = New-RoundPath $script:rectClose.Width $script:rectClose.Height (S 8)
      $closeState = $g.Save()
      $g.TranslateTransform($script:rectClose.X, $script:rectClose.Y)
      $g.FillPath($brushHover, $closePath)
      $g.Restore($closeState)
    }
    $closeRect = [System.Drawing.RectangleF]::new(($script:rectClose.X), ($script:rectClose.Y + (S 2)), $script:rectClose.Width, $script:rectClose.Height)
    $g.DrawString([string][char]0x00D7, $fontCaret, $brushMuted, $closeRect, $fmtCenter)

    $g.DrawLine($penDivider, $pad, (S 56), ($sender.Width - $pad), (S 56))

    $g.DrawString('检索结果', $fontSmall, $brushMuted, $pad, (S 120))
    if ($script:resultItems.Count -eq 0) {
      $g.DrawString('输入问题后点「检索」，从知识库里找回相关原文', $fontSmall, $brushMuted, $pad, (S 168))
    }

    $filesTop = $sender.Height - (S 240)
    $g.DrawLine($penDivider, $pad, ($filesTop - (S 42)), ($sender.Width - $pad), ($filesTop - (S 42)))
    $g.DrawString(('已入库文件 · ' + [string]$script:docCount), $fontSmall, $brushMuted, $pad, ($filesTop - (S 32)))
    if ($script:fileItems.Count -eq 0) {
      $g.DrawString('还没有文件，把 PDF / Word / 图片拖到这里即可入库', $fontSmall, $brushMuted, $pad, ($filesTop + (S 12)))
    }

    $statsText = '文件 ' + [string]$script:docCount + ' · 片段 ' + [string]$script:chunkCount + ' · 向量 ' + [string]$script:dim + ' 维'
    $g.DrawString($statsText, $fontTiny, $brushMuted, $pad, ($sender.Height - (S 44)))
    $hint = '把文件拖到这里即可入库'
    if ($script:flash -ne '') { $hint = $script:flash }
    $g.DrawString($hint, $fontTiny, $brushAccent, $pad, ($sender.Height - (S 26)))
  })

function New-RowCard($g, $rect, [bool]$hot, [bool]$selected) {
  $card = [System.Drawing.Rectangle]::new($rect.X + (S 6), $rect.Y + (S 3), $rect.Width - (S 12), $rect.Height - (S 6))
  $brush = $brushCard
  if ($selected) { $brush = $brushAccentSoft }
  elseif ($hot) { $brush = $brushHover }
  $path = New-RoundPath $card.Width $card.Height (S 10)
  $state = $g.Save()
  $g.TranslateTransform($card.X, $card.Y)
  $g.FillPath($brush, $path)
  $g.Restore($state)
  return $card
}

$results.Add_DrawItem({
    param($sender, $e)
    if ($e.Index -lt 0 -or $e.Index -ge $script:resultItems.Count) { return }
    $item = $script:resultItems[$e.Index]
    $g = $e.Graphics
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $rect = $e.Bounds
    $card = New-RowCard $g $rect ($script:resultsHot -eq $e.Index) (($e.State -band [System.Windows.Forms.DrawItemState]::Selected) -ne 0)
    $score = '相似度 ' + [string]$item.score
    $scoreW = S 68
    $headRect = [System.Drawing.RectangleF]::new(($card.X + (S 12)), ($card.Y + (S 8)), ($card.Width - $scoreW - (S 24)), (S 18))
    $g.DrawString([string]$item.file, $fontSmall, $brushText, $headRect, $fmtTrim)
    $scoreRect = [System.Drawing.RectangleF]::new(($card.Right - $scoreW - (S 10)), ($card.Y + (S 8)), $scoreW, (S 18))
    $g.DrawString($score, $fontTiny, $brushAccent, $scoreRect, $fmtFar)
    $snippet = ([string]$item.text).Replace("`r", ' ').Replace("`n", ' ')
    $body = [System.Drawing.RectangleF]::new(($card.X + (S 12)), ($card.Y + (S 30)), ($card.Width - (S 24)), (S 20))
    $g.DrawString($snippet, $fontTiny, $brushMuted, $body, $fmtTrim)
  })

$files.Add_DrawItem({
    param($sender, $e)
    if ($e.Index -lt 0 -or $e.Index -ge $script:fileItems.Count) { return }
    $item = $script:fileItems[$e.Index]
    $g = $e.Graphics
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $rect = $e.Bounds
    $card = New-RowCard $g $rect ($script:filesHot -eq $e.Index) (($e.State -band [System.Windows.Forms.DrawItemState]::Selected) -ne 0)
    $icon = [string][char]0xE8A5
    $ext = [string]$item.name
    $dot = $ext.LastIndexOf('.')
    if ($dot -ge 0) { $ext = $ext.Substring($dot + 1).ToLower() }
    if (@('png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg') -contains $ext) { $icon = [string][char]0xEB9F }
    elseif (@('pdf') -contains $ext) { $icon = [string][char]0xE8A5 }
    elseif (@('md', 'markdown', 'txt', 'log') -contains $ext) { $icon = [string][char]0xE70B }
    $iconRect = [System.Drawing.RectangleF]::new(($card.X + (S 10)), ($card.Y + (S 10)), (S 22), (S 22))
    $g.DrawString($icon, $fontGlyph, $brushMuted, $iconRect, $fmtCenter)
    $meta = [string]$item.chunks + ' 段'
    if ($item.bytes) { $meta = $meta + ' · ' + [string][Math]::Round(([double]$item.bytes / 1024), 1) + ' KB' }
    $metaW = S 96
    $nameRect = [System.Drawing.RectangleF]::new(($card.X + (S 38)), ($card.Y + (S 6)), ($card.Width - $metaW - (S 50)), (S 18))
    $g.DrawString([string]$item.name, $fontSmall, $brushText, $nameRect, $fmtTrim)
    $note = [string]$item.note
    if ($note -ne '') {
      $noteRect = [System.Drawing.RectangleF]::new(($card.X + (S 38)), ($card.Y + (S 22)), ($card.Width - $metaW - (S 50)), (S 16))
      $g.DrawString($note, $fontTiny, $brushMuted, $noteRect, $fmtTrim)
    }
    $metaRect = [System.Drawing.RectangleF]::new(($card.Right - $metaW - (S 10)), ($card.Y + (S 6)), $metaW, (S 18))
    $g.DrawString($meta, $fontTiny, $brushMuted, $metaRect, $fmtFar)
  })

# ── interactions ─────────────────────────────────────────────────────────────
$goBtn.Add_Click({
    $q = $search.Text.Trim()
    if ($q -eq '') { return }
    Send-Request 'search' @{ query = $q } | Out-Null
    Set-Flash '检索中…'
  })

$search.Add_KeyDown({
    param($sender, $e)
    if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Enter) {
      $goBtn.PerformClick()
      $e.SuppressKeyPress = $true
    }
  })

$removeBtn.Add_Click({
    if ($files.SelectedIndex -lt 0) { Set-Flash '先选中一个文件'; return }
    $name = [string]$script:fileItems[$files.SelectedIndex].name
    if (-not $script:removeArmed) {
      $script:removeArmed = $true
      $removeBtn.Text = '确认移除'
      $removeBtn.ForeColor = [System.Drawing.Color]::FromArgb(220, 38, 38)
      Set-Flash ('再点一次移除「' + $name + '」')
      return
    }
    $script:removeArmed = $false
    $removeBtn.Text = '移除'
    $removeBtn.ForeColor = $colMuted
    Send-Request 'remove' @{ name = $name } | Out-Null
  })

$files.Add_MouseMove({
    param($sender, $e)
    $index = $files.IndexFromPoint($e.Location)
    if ($index -ne $script:filesHot) { $script:filesHot = $index; $files.Invalidate() }
  })
$files.Add_MouseLeave({ $script:filesHot = -1; $files.Invalidate() })
$results.Add_MouseMove({
    param($sender, $e)
    $index = $results.IndexFromPoint($e.Location)
    if ($index -ne $script:resultsHot) { $script:resultsHot = $index; $results.Invalidate() }
  })
$results.Add_MouseLeave({ $script:resultsHot = -1; $results.Invalidate() })

$form.Add_MouseEnter({
    param($sender, $e)
    if ($script:edge -ne $null -and -not $script:expanded) {
      $form.Width = $WIDE
      if ($script:edge -eq 'right') { $form.Left = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Right - $form.Width }
      elseif ($script:edge -eq 'left') { $form.Left = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Left }
      Set-Shape
    }
  })

$form.Add_MouseLeave({
    param($sender, $e)
    if ($script:closeHot) { $script:closeHot = $false; $form.Invalidate() }
    if ($script:edge -ne $null -and -not $script:dragging -and -not $script:expanded) {
      $form.Width = $NARROW
      if ($script:edge -eq 'right') { $form.Left = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Right - $form.Width }
      elseif ($script:edge -eq 'left') { $form.Left = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Left }
      Set-Shape
    }
  })

$form.Add_MouseMove({
    param($sender, $e)
    if ($script:expanded) {
      $hot = $script:rectClose.Contains($e.Location)
      if ($hot -ne $script:closeHot) { $script:closeHot = $hot; $form.Invalidate() }
    }
    if (-not $script:dragging) { return }
    $now = [System.Windows.Forms.Cursor]::Position
    $dx = $now.X - $script:dragStart.X
    $dy = $now.Y - $script:dragStart.Y
    if ([Math]::Abs($dx) + [Math]::Abs($dy) -gt 3) { $script:moved = $true }
    $form.Location = [System.Drawing.Point]::new(($script:formStart.X + $dx), ($script:formStart.Y + $dy))
  })

$form.Add_MouseDown({
    param($sender, $e)
    if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
    if ($script:expanded -and $script:rectClose.Contains($e.Location)) { Set-Expanded $false; return }
    $script:dragging = $true
    $script:moved = $false
    $script:dragStart = [System.Windows.Forms.Cursor]::Position
    $script:formStart = $form.Location
  })

$form.Add_MouseUp({
    param($sender, $e)
    if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
    if (-not $script:dragging) { return }
    $script:dragging = $false
    if (-not $script:moved) {
      if (-not $script:expanded) { Set-Expanded $true }
      return
    }
    if ($script:expanded) { Save-Place; return }
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    if ($form.Left -le (S 40)) { $script:edge = 'left' }
    elseif ($form.Right -ge ($wa.Right - (S 40))) { $script:edge = 'right' }
    else { $script:edge = $null }
    if ($script:edge -ne $null) {
      $form.Top = [Math]::Max($wa.Top, [Math]::Min($form.Top, ($wa.Bottom - $form.Height)))
      $form.Width = $NARROW
      if ($script:edge -eq 'right') { $form.Left = $wa.Right - $form.Width }
      elseif ($script:edge -eq 'left') { $form.Left = $wa.Left }
      Set-Shape
    }
    else {
      $form.Width = $WIDE
      Set-Shape
    }
    Save-Place
  })

$form.Add_DragEnter({
    param($sender, $e)
    if ($e.Data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) { $e.Effect = [System.Windows.Forms.DragDropEffects]::Copy }
    else { $e.Effect = [System.Windows.Forms.DragDropEffects]::None }
  })

$form.Add_DragDrop({
    param($sender, $e)
    try {
      $dropped = $e.Data.GetData([System.Windows.Forms.DataFormats]::FileDrop)
      foreach ($item in $dropped) { Send-Request 'ingest' @{ path = $item } | Out-Null }
      Set-Flash ('正在入库 ' + [string]$dropped.Count + ' 个文件…')
    } catch { }
  })

$pollTimer = New-Object System.Windows.Forms.Timer
$pollTimer.Interval = 350
$pollTimer.Add_Tick({ Poll-Responses })
$pollTimer.Start()

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menuOpen = $menu.Items.Add('打开网页面板')
$menuOpen.Add_Click({ try { Start-Process $script:Url } catch { } })
$menuPanel = $menu.Items.Add('展开桌面面板')
$menuPanel.Add_Click({ Set-Expanded $true })
$menuExit = $menu.Items.Add('退出桌面图标')
$menuExit.Add_Click({ $form.Close() })
$form.ContextMenuStrip = $menu

$form.Add_FormClosing({ param($sender, $e) Save-Place })

$posFile = Join-Path $script:Dir 'desktop.pos'
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Left = $wa.Right - $WIDE - (S 24)
$form.Top = $wa.Top + (S 12)
if (Test-Path -LiteralPath $posFile) {
  try {
    $parts = (Get-Content -LiteralPath $posFile -TotalCount 1) -split ','
    if ($parts.Length -ge 2) {
      $form.Left = [int]$parts[0]
      $form.Top = [int]$parts[1]
    }
    if ($parts.Length -ge 3 -and $parts[2] -ne '') { $script:edge = $parts[2] }
  } catch { }
}
# A saved position can fall outside the current working area (resolution change,
# display removed); pull the pill back so it stays clickable.
$form.Left = [Math]::Max($wa.Left, [Math]::Min($form.Left, ($wa.Right - $WIDE)))
$form.Top = [Math]::Max($wa.Top, [Math]::Min($form.Top, ($wa.Bottom - $PILL_H)))

Set-Shape
if ($script:edge -ne $null) {
  $form.Width = $NARROW
  if ($script:edge -eq 'right') { $form.Left = $wa.Right - $form.Width }
  elseif ($script:edge -eq 'left') { $form.Left = $wa.Left }
  Set-Shape
}

try { Set-Content -LiteralPath $PidFile -Value $PID -Encoding ASCII } catch { }

if ($StartExpanded) { Set-Expanded $true }

[System.Windows.Forms.Application]::add_ThreadException({
    param($sender, $eventArgs)
    try {
      $detail = ($eventArgs.Exception.Message)
      if ($eventArgs.Exception.ErrorRecord -ne $null) {
        $detail = $detail + [Environment]::NewLine + 'POS: ' + $eventArgs.Exception.ErrorRecord.InvocationInfo.PositionMessage
        $detail = $detail + [Environment]::NewLine + 'STACK:' + [Environment]::NewLine + $eventArgs.Exception.ErrorRecord.ScriptStackTrace
      }
      Add-Content -LiteralPath (Join-Path $script:Dir 'ui-error.log') -Value ($detail + [Environment]::NewLine + '=====' + [Environment]::NewLine) -Encoding UTF8
    } catch { }
  })

[System.Windows.Forms.Application]::Run($form)
