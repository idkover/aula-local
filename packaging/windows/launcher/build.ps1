# Compila el lanzador de aula-local (Launcher.cs) con csc.exe de .NET Framework 4.x.
# Uso: powershell -ExecutionPolicy Bypass -File build.ps1 -OutDir X -Icon Y
param(
    [string]$OutDir = '',
    [string]$Icon = ''
)

$ErrorActionPreference = 'Stop'

# Resuelve una ruta relativa contra la carpeta actual de PowerShell.
function Resolver-Ruta([string]$ruta) {
    if ([System.IO.Path]::IsPathRooted($ruta)) {
        return [System.IO.Path]::GetFullPath($ruta)
    }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $ruta))
}

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
    Write-Host "ERROR: no se encontró el compilador en $csc. Instala .NET Framework 4.x." -ForegroundColor Red
    exit 1
}

$src = Join-Path $PSScriptRoot 'Launcher.cs'
$manifest = Join-Path $PSScriptRoot 'app.manifest'
if (-not (Test-Path -LiteralPath $src)) {
    Write-Host "ERROR: falta el código fuente $src" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $manifest)) {
    Write-Host "ERROR: falta el manifiesto $manifest" -ForegroundColor Red
    exit 1
}

# Carpeta de salida (por defecto: launcher\bin)
if ([string]::IsNullOrEmpty($OutDir)) { $OutDir = Join-Path $PSScriptRoot 'bin' }
$OutDir = Resolver-Ruta $OutDir
if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}
$exe = Join-Path $OutDir 'aula-local.exe'

$argumentos = @(
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/optimize+',
    "/out:$exe",
    "/win32manifest:$manifest",
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.dll'
)

if ($Icon -ne '') {
    $iconoFull = Resolver-Ruta $Icon
    if (Test-Path -LiteralPath $iconoFull) {
        $argumentos += "/win32icon:$iconoFull"
    } else {
        Write-Host "AVISO: no existe el icono $iconoFull; se compila sin icono." -ForegroundColor Yellow
    }
}

$argumentos += $src

Write-Host "Compilando con $csc ..."
& $csc @argumentos
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: la compilación falló (código $LASTEXITCODE)." -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "Listo: $exe" -ForegroundColor Green
exit 0
