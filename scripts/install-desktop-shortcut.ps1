<#
.SYNOPSIS
    Creates (or refreshes) a desktop shortcut that launches the packaged
    BranchMap application.

.DESCRIPTION
    The shortcut points at the installed application executable, NOT at
    "npm run desktop:dev". Nothing here is specific to a particular machine:
    the install location is resolved at run time, so the script can be reused
    after moving the project or reinstalling.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/install-desktop-shortcut.ps1
#>
[CmdletBinding()]
param(
    # Optional override if the app lives somewhere non-standard.
    [string]$Executable
)

$ErrorActionPreference = 'Stop'

function Resolve-BranchMapExe {
    param([string]$Override)

    if ($Override) {
        if (-not (Test-Path -LiteralPath $Override)) {
            throw "Executable not found: $Override"
        }
        return (Resolve-Path -LiteralPath $Override).Path
    }

    # Search the usual install locations for a packaged build.
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'BranchMap\branchmap.exe'),
        (Join-Path $env:ProgramFiles 'BranchMap\branchmap.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'BranchMap\branchmap.exe')
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    # Fall back to the freshly built binary inside the source tree.
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $localBuild = Join-Path $repoRoot 'src-tauri\target\release\branchmap.exe'
    if (Test-Path -LiteralPath $localBuild) {
        return (Resolve-Path -LiteralPath $localBuild).Path
    }

    throw 'BranchMap was not found. Install it first (npm run desktop:build then run the NSIS installer).'
}

$exe = Resolve-BranchMapExe -Override $Executable

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'BranchMap.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = Split-Path -Parent $exe
$shortcut.Description = 'BranchMap - visual Git repository explorer (packaged application)'
$shortcut.IconLocation = "$exe,0"
# Start minimised to the tray is not used; open normally.
$shortcut.WindowStyle = 1
$shortcut.Save()

Write-Output "Shortcut created: $shortcutPath"
Write-Output "Target:            $exe"