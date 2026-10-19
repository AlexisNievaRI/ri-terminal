# Publica una version nueva: .\release.ps1 0.2.1
param([Parameter(Mandatory = $true)][string]$Version)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Usa el formato 1.2.3' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Falta 'git' en el PATH." }
if (git tag --list "v$Version") { throw "La version v$Version ya existe." }
$utf8 = New-Object System.Text.UTF8Encoding $false
function SetVer($path, $pattern) {
  $full = Join-Path $PSScriptRoot $path
  $t = [IO.File]::ReadAllText($full)
  $n = [regex]::new($pattern, 'Multiline').Replace($t, ('${1}' + $Version + '${2}'), 1)
  [IO.File]::WriteAllText($full, $n, $utf8)
}
SetVer 'package.json' '("version":\s*")[^"]+(")'
SetVer 'src-tauri\tauri.conf.json' '("version":\s*")[^"]+(")'
SetVer 'src-tauri\Cargo.toml' '(^version\s*=\s*")[^"]+(")'
git add -A
git commit -m "Version $Version"
git tag "v$Version"
git push
git push origin "v$Version"
Write-Host "`nListo. GitHub esta compilando v$Version (pestana Actions del repo). En unos minutos aparece en Releases." -ForegroundColor Green
