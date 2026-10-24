# Busca los archivos de un ticket (los que sube mesa de entrada empiezan con el numero de tarea).
# Uso:  buscar-ticket.ps1 -Tarea 257062 [-Cliente Refineria]
#       buscar-ticket.ps1 -Menus [-Filtro texto]
param(
  [Parameter(Position = 0)][string]$Tarea,
  [string]$Cliente,
  [switch]$Menus,
  [string]$Filtro
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$cfgPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'config.json'
$cfg = Get-Content -Raw -Encoding UTF8 -LiteralPath $cfgPath | ConvertFrom-Json

function Fila($f, $cli) {
  '{0} | {1} | {2:yyyy-MM-dd HH:mm} | {3} KB | {4}' -f $cli, $f.Name, $f.LastWriteTime, [math]::Ceiling($f.Length / 1KB), $f.FullName
}

if ($Menus) {
  $ext = [string]$cfg.menuExt
  if ($ext -and -not $ext.StartsWith('.')) { $ext = '.' + $ext }
  if (-not (Test-Path -LiteralPath $cfg.menus)) { Write-Host "No existe la carpeta de menus: $($cfg.menus)"; exit 1 }
  $m = Get-ChildItem -LiteralPath $cfg.menus -File | Where-Object { $_.Extension -ieq $ext -and (-not $Filtro -or $_.Name -like "*$Filtro*") } | Sort-Object Name
  if (-not $m) { Write-Host "Sin menus ($ext) en $($cfg.menus)"; exit 0 }
  foreach ($f in $m) { Fila $f 'menu' }
  exit 0
}

if (-not $Tarea) { Write-Host 'Uso: buscar-ticket.ps1 -Tarea <numero> [-Cliente <nombre>]  |  buscar-ticket.ps1 -Menus [-Filtro <texto>]'; exit 1 }
if (-not (Test-Path -LiteralPath $cfg.base)) { Write-Host "No existe la carpeta base: $($cfg.base). Verifica que la unidad este conectada."; exit 1 }

$t = $Tarea.Trim()
$cands = @($t)
$dig = $t -replace '\D', ''
if ($dig.Length -ge 4 -and $dig -ne $t) { $cands += $dig }

$clientes = Get-ChildItem -LiteralPath $cfg.base -Directory
if ($Cliente) { $clientes = $clientes | Where-Object { $_.Name -like "*$Cliente*" } }
$n = 0
foreach ($c in $clientes) {
  $dir = if ($cfg.archivos) { Join-Path $c.FullName $cfg.archivos } else { $c.FullName }
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  $files = Get-ChildItem -LiteralPath $dir -File | Where-Object {
    $nm = $_.Name
    $hit = $false
    foreach ($k in $cands) { if ($nm.StartsWith($k, [StringComparison]::OrdinalIgnoreCase)) { $hit = $true } }
    $hit
  } | Sort-Object Name
  foreach ($f in $files) { $n++; Fila $f $c.Name }
}
if ($n -eq 0) { Write-Host "Sin archivos para la tarea $t en $($cfg.base)" }
