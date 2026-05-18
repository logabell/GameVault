[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $ExePath,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+$')]
    [string] $AppId,

    [string] $WorkingDirectory,

    [string] $SteamExe,

    [ValidateSet('Auto', 'Duo', 'Direct')]
    [string] $Mode = 'Auto',

    [switch] $WriteSteamAppId,

    [switch] $MirrorSteamActiveProcess,

    [switch] $WaitForGameExit,

    [switch] $VerifyOnly,

    [ValidateRange(1, 60)]
    [int] $StartupWaitSeconds = 15
)

$ErrorActionPreference = 'Stop'

function Get-SteamExePath {
    if ($SteamExe) {
        return $SteamExe
    }

    $steamKey = Get-ItemProperty -LiteralPath 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue
    if ($steamKey -and $steamKey.SteamExe) {
        return $steamKey.SteamExe -replace '/', '\'
    }

    $machineKey = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam' -ErrorAction SilentlyContinue
    if ($machineKey -and $machineKey.InstallPath) {
        return Join-Path $machineKey.InstallPath 'steam.exe'
    }

    return 'C:\Program Files (x86)\Steam\steam.exe'
}

function Get-CurrentSessionSteam {
    $sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId

    Get-CimInstance Win32_Process -Filter "Name = 'steam.exe'" |
        Where-Object { $_.SessionId -eq $sessionId } |
        Select-Object -First 1
}

function Test-DuoSteamContext {
    param(
        [string] $Sid,
        $SessionSteam
    )

    if ($env:GAMEVAULT_DUO_CONTEXT -eq '1') {
        return $true
    }

    if ($env:steam_master_ipc_name_override) {
        return $true
    }

    if ($env:__COMPAT_LAYER -match '(^|\s)Duo($|\s)') {
        return $true
    }

    if ($SessionSteam -and $SessionSteam.CommandLine) {
        return $SessionSteam.CommandLine -match [regex]::Escape('-master_ipc_name_override')
    }

    return $false
}

function Set-DuoEnvironment {
    param([Parameter(Mandatory = $true)][string] $Sid)

    if (-not $env:__COMPAT_LAYER) {
        $env:__COMPAT_LAYER = 'Duo'
    }
    elseif ($env:__COMPAT_LAYER -notmatch '(^|\s)Duo($|\s)') {
        $env:__COMPAT_LAYER = "$($env:__COMPAT_LAYER) Duo"
    }

    $env:steam_master_ipc_name_override = $Sid
}

function Set-SteamIdentityEnvironment {
    param([Parameter(Mandatory = $true)][string] $SteamAppId)

    $env:SteamAppId = $SteamAppId
    $env:SteamGameId = $SteamAppId
    $env:SteamOverlayGameId = $SteamAppId
}

function Set-SteamActiveProcess {
    param(
        [Parameter(Mandatory = $true)]
        [int] $SteamPid,

        [Parameter(Mandatory = $true)]
        [string] $SteamDirectory
    )

    $activeProcessKey = 'HKCU:\Software\Valve\Steam\ActiveProcess'
    $steamClientDll = Join-Path $SteamDirectory 'steamclient.dll'
    $steamClientDll64 = Join-Path $SteamDirectory 'steamclient64.dll'

    if (-not (Test-Path -LiteralPath $steamClientDll)) {
        throw "Steam client DLL not found: $steamClientDll"
    }

    if (-not (Test-Path -LiteralPath $steamClientDll64)) {
        throw "Steam client DLL not found: $steamClientDll64"
    }

    try {
        $null = New-Item -Path $activeProcessKey -Force
        New-ItemProperty -LiteralPath $activeProcessKey -Name 'pid' -Value $SteamPid -PropertyType DWord -Force | Out-Null
        New-ItemProperty -LiteralPath $activeProcessKey -Name 'SteamClientDll' -Value $steamClientDll -PropertyType String -Force | Out-Null
        New-ItemProperty -LiteralPath $activeProcessKey -Name 'SteamClientDll64' -Value $steamClientDll64 -PropertyType String -Force | Out-Null
        New-ItemProperty -LiteralPath $activeProcessKey -Name 'Universe' -Value 'Public' -PropertyType String -Force | Out-Null
        return
    }
    catch [System.IO.IOException] {
        if ($_.Exception.Message -notmatch 'volatile parent key') {
            throw
        }
    }

    $steamKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Valve\Steam', $true)
    if (-not $steamKey) {
        throw 'HKCU\Software\Valve\Steam does not exist.'
    }

    try {
        $activeProcess = $steamKey.CreateSubKey(
            'ActiveProcess',
            [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,
            [Microsoft.Win32.RegistryOptions]::Volatile
        )

        if (-not $activeProcess) {
            throw 'Failed to create volatile HKCU\Software\Valve\Steam\ActiveProcess.'
        }

        try {
            $activeProcess.SetValue('pid', $SteamPid, [Microsoft.Win32.RegistryValueKind]::DWord)
            $activeProcess.SetValue('SteamClientDll', $steamClientDll, [Microsoft.Win32.RegistryValueKind]::String)
            $activeProcess.SetValue('SteamClientDll64', $steamClientDll64, [Microsoft.Win32.RegistryValueKind]::String)
            $activeProcess.SetValue('Universe', 'Public', [Microsoft.Win32.RegistryValueKind]::String)
        }
        finally {
            $activeProcess.Dispose()
        }
    }
    finally {
        $steamKey.Dispose()
    }
}

$resolvedExe = (Resolve-Path -LiteralPath $ExePath).Path

if (-not $WorkingDirectory) {
    $WorkingDirectory = Split-Path -Parent $resolvedExe
}

$resolvedWorkingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path
$steamExePath = Get-SteamExePath

if (-not (Test-Path -LiteralPath $steamExePath)) {
    throw "Steam executable not found: $steamExePath"
}

$sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$sessionSteam = Get-CurrentSessionSteam
$useDuo = $Mode -eq 'Duo' -or ($Mode -eq 'Auto' -and (Test-DuoSteamContext -Sid $sid -SessionSteam $sessionSteam))

if ($WriteSteamAppId) {
    $steamAppIdPath = Join-Path $resolvedWorkingDirectory 'steam_appid.txt'
    Set-Content -LiteralPath $steamAppIdPath -Value $AppId -NoNewline -Encoding ASCII
}

Set-SteamIdentityEnvironment -SteamAppId $AppId

Write-Host "Launch mode: $(if ($useDuo) { 'Duo' } else { 'Direct' })"
Write-Host "SteamAppId: $env:SteamAppId"
Write-Host "Steam path: $steamExePath"
Write-Host "Session Steam PID: $(if ($sessionSteam) { $sessionSteam.ProcessId } else { 'not running' })"
Write-Host "Exe: $resolvedExe"
Write-Host "Working directory: $resolvedWorkingDirectory"

if ($VerifyOnly) {
    return
}

if ($useDuo) {
    Set-DuoEnvironment -Sid $sid
    if (-not $sessionSteam) {
        Start-Process -FilePath $steamExePath -ArgumentList @('-master_ipc_name_override', $sid)

        $deadline = (Get-Date).AddSeconds($StartupWaitSeconds)
        do {
            Start-Sleep -Milliseconds 500
            $sessionSteam = Get-CurrentSessionSteam
        } while (-not $sessionSteam -and (Get-Date) -lt $deadline)

        if (-not $sessionSteam) {
            throw "Steam did not appear in this Duo session within $StartupWaitSeconds seconds."
        }
    }

    if ($MirrorSteamActiveProcess) {
        Set-SteamActiveProcess -SteamPid ([int] $sessionSteam.ProcessId) -SteamDirectory (Split-Path -Parent $steamExePath)
        Write-Host "Mirrored HKCU Steam ActiveProcess to session Steam PID: $($sessionSteam.ProcessId)"
    }
}

$process = Start-Process -FilePath $resolvedExe -WorkingDirectory $resolvedWorkingDirectory -PassThru
if ($WaitForGameExit -and $process) {
    $process.WaitForExit()
    exit $process.ExitCode
}
