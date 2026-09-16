# AIplaygrand-Win 휴대용 자체 업데이트 도우미 (Windows PowerShell 5.1, 관리자 권한·실행 정책 변경 없음)
#
# 앱(main 프로세스)이 이 파일을 스테이지 폴더(<앱 폴더>\.aiplaygrand-update\<UUID>)에 UTF-8 BOM으로 복사한 뒤
#   powershell.exe -NoProfile -NonInteractive -File apply-update.ps1 -Action Apply -StageDir <스테이지> -AppDir <앱 폴더> -ParentPid <앱 PID>
# 로 실행한다. 렌더러나 원격 값으로 스크립트를 조립하지 않으며, 모든 입력은 여기서 다시 검증한다.
#
# Apply 단계
#   1. 준비(Prepare): 경로·메타·ZIP(SHA-256, 허용 목록, 링크 항목)·여유 공간을 검사하고 extracted\ 에 풀어 해시를 저널에 기록한 뒤
#      helper-ready.json 을 쓴다. 이 단계에서는 앱 파일을 절대 건드리지 않는다.
#   2. 대기: apply-authorized.json(정상 '저장하고 종료' 뒤 앱이 작성)과 실제 부모 프로세스 종료를 '둘 다' 확인한다.
#      취소 마커가 있거나 승인 없이 부모가 끝나면 아무것도 바꾸지 않고 종료한다.
#   3. 교체: 잠금 확인 → 저널 'applying' → 원본을 backup\ 으로 이동 → 새 파일을 제자리로 이동 → 설치 해시 검증 → 'committed' → 재시작.
#      파일을 하나 옮기기 '전'에 의도 단계(backing_up/placing)를 저널에 먼저 쓰고, 옮긴 '뒤'에 완료 단계(backed_up/placed)를 쓴다.
#      실패하면 저널을 바탕으로 롤백한다. 롤백이 완전할 때만 이전 버전을 재시작하고, 섞인 상태(mixed)에서는 재시작하지 않는다.
# 롤백: 저널의 단계 표시를 믿고 건너뛰지 않는다. 항목마다 제자리 파일과 backup\ 파일의 실제 해시를 원본(oldHash)·새 파일(newHash)과
#      대조해 되돌리고, 마지막에 모든 항목이 원본 상태(원본 해시 일치 또는 원래 없던 파일이 없음)인지 다시 확인한 뒤에만 rolled_back 으로 보고한다.
#      원본을 덮어쓰거나 지우지 않으며 backup\ 은 어떤 경우에도 지우지 않는다.
# Recover: 전원 차단 등으로 중단된 저널을 읽어 같은 롤백 절차를 다시 실행한다(멱등).
# 요구 사항: Windows PowerShell 5.1 + .NET Framework 4.7.2 이상(ZipArchiveEntry.ExternalAttributes 로 링크 항목을 검사한다).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [ValidateSet('Apply', 'Recover')]
    [string]$Action = 'Apply',

    [Parameter(Mandatory = $true)]
    [string]$StageDir,

    [Parameter(Mandatory = $true)]
    [string]$AppDir,

    [Parameter(Mandatory = $false)]
    [int]$ParentPid = 0
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 상수
$script:AllowedRootFiles = @(
    'AIplaygrand-Win.exe', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll',
    'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll', 'libGLESv2.dll', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
    'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll', 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'version',
    'USB-시작하기.txt', '시연-안내.md'
)
$script:LocaleFileRegex = '^[A-Za-z0-9_\-]{1,32}\.pak$'
$script:UuidRegex = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$script:SemverRegex = '^\d{1,6}\.\d{1,6}\.\d{1,6}$'
$script:Sha256Regex = '^[0-9a-f]{64}$'
$script:MaxZipEntries = 400
$script:MaxLocaleFiles = 200
$script:MaxSingleFileBytes = 400MB
$script:MaxTotalUnpackedBytes = 1536MB
$script:MinZipBytes = 10MB
$script:MaxZipBytes = 1GB
$script:MaxJsonBytes = 1MB
$script:AuthWaitMaxSeconds = 12 * 60 * 60
$script:ParentExitWaitSeconds = 120
$script:LockWaitSeconds = 30
$script:AuthMaxAgeMinutes = 30
# 저널 항목 단계: pending(손대지 않음) → backing_up(원본 이동 직전) → backed_up → placing(새 파일 이동 직전) → placed → restored(롤백 확인)
$script:KnownPhases = @('pending', 'backing_up', 'backed_up', 'placing', 'placed', 'restored')

$script:LogPath = $null
$script:Phase = 'preflight'      # preflight | waiting | mutating | done
$script:ReadyAt = $null

# ---------------------------------------------------------------- 공통 함수
function Write-Log([string]$message) {
    $line = "[{0}] {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $message
    if ($script:LogPath) {
        try { [System.IO.File]::AppendAllText($script:LogPath, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($true))) } catch {}
    }
    if ($Action -eq 'Recover') { Write-Host $line }
}

function Get-Prop($object, [string]$name) {
    if ($null -eq $object) { return $null }
    $prop = $object.PSObject.Properties[$name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function Test-ReparsePoint([string]$path) {
    $attributes = [System.IO.File]::GetAttributes($path)
    return (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Test-RegularFile([string]$path) {
    if (-not [System.IO.File]::Exists($path)) { return $false }
    if (Test-ReparsePoint $path) { return $false }
    return $true
}

function Assert-DirectoryChain([string]$path, [string]$label) {
    # 경로 자체와 모든 상위 폴더가 실제 폴더이며 reparse point(정션·심볼릭 링크)가 아니어야 한다.
    $root = [System.IO.Path]::GetPathRoot($path)
    $current = $path
    while ($true) {
        if (-not [System.IO.Directory]::Exists($current)) { throw "$label 경로가 폴더가 아니거나 없습니다: $current" }
        if (Test-ReparsePoint $current) { throw "$label 경로에 정션·심볼릭 링크가 있어 업데이트하지 않습니다: $current" }
        $parent = [System.IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrEmpty($parent) -or [string]::Equals($parent.TrimEnd('\'), $root.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { break }
        $current = $parent
    }
}

function Get-FileSha256([string]$path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
        $bytes = $sha.ComputeHash($stream)
        return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    } finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}

function Read-JsonFile([string]$path) {
    if (-not (Test-RegularFile $path)) { throw "파일이 없거나 일반 파일이 아닙니다: $path" }
    $length = (New-Object System.IO.FileInfo($path)).Length
    if ($length -gt $script:MaxJsonBytes) { throw "파일이 너무 큽니다: $path" }
    $raw = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    $data = $raw | ConvertFrom-Json
    if ($null -eq $data) { throw "JSON을 읽지 못했습니다: $path" }
    return $data
}

function Write-AtomicJson([string]$path, $object) {
    # 임시 파일에 쓰고 Flush(true)로 디스크에 내린 뒤 기존 파일을 .prev.json 으로 옮기고 임시 파일을 제자리로 옮긴다.
    # 본 파일을 잘라 쓰지 않으므로 중간에 전원이 끊겨도 직전 저널이 남는다.
    $json = $object | ConvertTo-Json -Depth 8
    $tmp = $path + '.tmp'
    $prev = [System.IO.Path]::ChangeExtension($path, '.prev.json')
    if ([System.IO.File]::Exists($tmp)) { [System.IO.File]::Delete($tmp) }
    $stream = New-Object System.IO.FileStream($tmp, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($json)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    if ([System.IO.File]::Exists($path)) {
        if ([System.IO.File]::Exists($prev)) { [System.IO.File]::Delete($prev) }
        [System.IO.File]::Move($path, $prev)
    }
    [System.IO.File]::Move($tmp, $path)
}

function Write-Result([string]$status, [string]$version, [string]$errorText) {
    try {
        $result = [pscustomobject]@{
            status = $status
            updateId = $script:UpdateId
            version = $version
            error = $errorText
            phase = $script:Phase
            at = (Get-Date).ToString('o')
        }
        Write-AtomicJson (Join-Path $StageDir 'result.json') $result
    } catch {
        Write-Log "결과 파일을 쓰지 못했습니다: $($_.Exception.Message)"
    }
}

function Show-Alert([string]$title, [string]$message) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show($message, $title, [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning)
    } catch {}
}

function Test-ManagedRelativePath([string]$rel) {
    # '/' 구분 상대 경로. 고정 허용 목록만 통과하며 대소문자까지 정확히 일치해야 한다.
    if ([string]::IsNullOrEmpty($rel)) { return $false }
    if ($rel -match '[\x00-\x1F\x7F:*?"<>|\\]') { return $false }
    if ($rel -notmatch '/') { return ($script:AllowedRootFiles -ccontains $rel) }
    if ($rel -cmatch '^locales/([^/]+)$') { return ($Matches[1] -cmatch $script:LocaleFileRegex) }
    if ($rel -ceq 'resources/app.asar') { return $true }
    return $false
}

function Get-RelativeTarget([string]$baseDir, [string]$rel) {
    if (-not (Test-ManagedRelativePath $rel)) { throw "관리 대상이 아닌 경로입니다: $rel" }
    return [System.IO.Path]::Combine($baseDir, $rel.Replace('/', '\'))
}

function Test-FileUnlocked([string]$path) {
    # 공유 없이 열어 본다: 실행 중인 exe·열린 DLL 은 공유 위반으로 실패한다. 읽기 전용 속성 파일도 검사할 수 있도록 Read 로 연다.
    try {
        $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
        $stream.Dispose()
        return $true
    } catch { return $false }
}

function Wait-FilesUnlocked([string[]]$paths) {
    $deadline = (Get-Date).AddSeconds($script:LockWaitSeconds)
    while ($true) {
        $locked = @()
        foreach ($p in $paths) { if ([System.IO.File]::Exists($p) -and -not (Test-FileUnlocked $p)) { $locked += $p } }
        if ($locked.Count -eq 0) { return }
        if ((Get-Date) -gt $deadline) { throw "다른 프로그램이 파일을 사용 중이라 교체할 수 없습니다: $($locked -join ', ')" }
        Start-Sleep -Seconds 1
    }
}

function Test-ParentRunning() {
    if ($ParentPid -le 0) { return $false }
    $p = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    return ($null -ne $p)
}

function Ensure-Directory([string]$path) {
    if ([System.IO.Directory]::Exists($path)) {
        if (Test-ReparsePoint $path) { throw "정션·심볼릭 링크 폴더에는 쓰지 않습니다: $path" }
        return
    }
    if ([System.IO.File]::Exists($path)) { throw "폴더 자리에 파일이 있습니다: $path" }
    [void][System.IO.Directory]::CreateDirectory($path)
}

function Move-FileStrict([string]$from, [string]$to) {
    # 덮어쓰기 없음: 대상이 이미 있으면 실패한다. 같은 볼륨 안의 이름 변경이다.
    if (-not (Test-RegularFile $from)) { throw "옮길 파일이 없거나 일반 파일이 아닙니다: $from" }
    if ([System.IO.File]::Exists($to) -or [System.IO.Directory]::Exists($to)) { throw "대상이 이미 있어 덮어쓰지 않습니다: $to" }
    Ensure-Directory ([System.IO.Path]::GetDirectoryName($to))
    [System.IO.File]::Move($from, $to)
}

function Get-UniquePath([string]$path) {
    if (-not ([System.IO.File]::Exists($path) -or [System.IO.Directory]::Exists($path))) { return $path }
    $i = 1
    while ($true) {
        $candidate = "$path.$i"
        if (-not ([System.IO.File]::Exists($candidate) -or [System.IO.Directory]::Exists($candidate))) { return $candidate }
        $i++
        if ($i -gt 1000) { throw "보관 경로를 정하지 못했습니다: $path" }
    }
}

# 롤백 전 저널 항목 사전 검증. 하나라도 이상하면 예외를 던져(파일을 옮기기 전) 'rollback_failed' 로 처리하게 한다.
# 검사: 허용 경로, 중복(대소문자 무시), 단계 값, 해시 형식, existed 형식, 대상·백업 자리의 폴더/링크, 상위 폴더의 정션·링크.
function Get-ValidatedJournalEntries($journal) {
    $files = @(Get-Prop $journal 'files')
    if ($files.Count -eq 0) { throw "저널에 파일 항목이 없습니다." }
    $backupRoot = Join-Path $StageDir 'backup'
    $seen = @{}
    $validated = New-Object System.Collections.ArrayList
    foreach ($entry in $files) {
        if ($null -eq $entry) { throw "저널에 빈 항목이 있습니다." }
        $rel = [string](Get-Prop $entry 'rel')
        if (-not (Test-ManagedRelativePath $rel)) { throw "저널에 관리 대상이 아닌 경로가 있습니다: $rel" }
        $lower = $rel.ToLowerInvariant()
        if ($seen.ContainsKey($lower)) { throw "저널에 중복 항목이 있습니다: $rel" }
        $seen[$lower] = $true
        $phase = [string](Get-Prop $entry 'phase')
        if ($script:KnownPhases -notcontains $phase) { throw "저널 항목의 단계 값이 올바르지 않습니다: $rel ($phase)" }
        $newHash = ([string](Get-Prop $entry 'newHash')).ToLowerInvariant()
        if ($newHash -notmatch $script:Sha256Regex) { throw "저널 항목의 새 파일 해시 형식이 올바르지 않습니다: $rel" }
        $existedRaw = Get-Prop $entry 'existed'
        if ($existedRaw -isnot [bool]) { throw "저널 항목의 existed 값이 올바르지 않습니다: $rel" }
        $existed = [bool]$existedRaw
        $oldHash = ([string](Get-Prop $entry 'oldHash')).ToLowerInvariant()
        if ($existed -and $oldHash -notmatch $script:Sha256Regex) { throw "저널 항목의 원본 해시 형식이 올바르지 않습니다: $rel" }
        $target = Get-RelativeTarget $AppDir $rel
        $backup = Get-RelativeTarget $backupRoot $rel
        foreach ($p in @($target, $backup)) {
            $parent = [System.IO.Path]::GetDirectoryName($p)
            if ([System.IO.Directory]::Exists($parent) -and (Test-ReparsePoint $parent)) { throw "정션·심볼릭 링크 폴더가 있어 복구하지 않습니다: $parent" }
            if ([System.IO.Directory]::Exists($p)) { throw "파일 자리에 폴더가 있어 복구하지 않습니다: $p" }
            if ([System.IO.File]::Exists($p) -and (Test-ReparsePoint $p)) { throw "파일 자리에 링크가 있어 복구하지 않습니다: $p" }
        }
        [void]$validated.Add([pscustomobject]@{ entry = $entry; rel = $rel; target = $target; backup = $backup; existed = $existed; oldHash = $oldHash; newHash = $newHash })
    }
    return @($validated.ToArray())
}

# 저널 기반 롤백(멱등). 반환: 'rolled_back' | 'mixed'. 예외는 호출자가 'rollback_failed'로 처리한다.
# 저널의 단계 표시(pending/restored 등)를 믿고 건너뛰지 않는다. 전원 차단은 '옮긴 뒤, 단계를 쓰기 전'에도 일어나므로
# 항목마다 제자리 파일과 backup\ 파일의 실제 해시로 상태를 판정한다.
# - 원본이 있던 항목: 백업이 있으면 백업이 원본이다. 제자리의 새 파일(newHash)은 failed\ 로 옮기고 백업을 되돌린다.
#   백업이 없으면 제자리 파일이 원본 해시일 때만 정상(아직 옮기지 않았거나 새 파일과 같은 내용)이며 그대로 둔다.
#   같은 내용(oldHash == newHash)이라도 백업이 없는 원본을 먼저 옮겨 내지 않는다.
# - 원본이 없던 항목: 제자리의 새 파일은 failed\ 로 옮긴다. 알 수 없는 내용은 건드리지 않는다.
# - 마지막에 모든 항목을 다시 검증(원본 해시 일치 또는 원래 없던 파일이 없음)해야 rolled_back 이다. backup\ 은 지우지 않는다.
function Invoke-Rollback($journal, [string]$journalPath) {
    $items = Get-ValidatedJournalEntries $journal
    $failedRoot = Join-Path $StageDir 'failed'
    $mixed = $false
    for ($i = $items.Count - 1; $i -ge 0; $i--) {
        $item = $items[$i]
        $rel = $item.rel
        $target = $item.target
        $backup = $item.backup
        $targetHash = $null
        if ([System.IO.File]::Exists($target)) { $targetHash = Get-FileSha256 $target }
        $backupHash = $null
        if ([System.IO.File]::Exists($backup)) { $backupHash = Get-FileSha256 $backup }
        $settled = $false

        if ($item.existed) {
            if ($null -ne $backupHash -and $backupHash -ne $item.oldHash) {
                Write-Log "롤백: 백업 해시가 저널과 달라 건드리지 않습니다: $rel"
            } elseif ($null -ne $backupHash) {
                if ($null -eq $targetHash) {
                    Move-FileStrict $backup $target
                    Write-Log "롤백: 백업에서 원본을 복원했습니다: $rel"
                    $settled = $true
                } elseif ($targetHash -eq $item.newHash) {
                    $failedPath = Get-UniquePath (Get-RelativeTarget $failedRoot $rel)
                    Move-FileStrict $target $failedPath
                    Write-Log "롤백: 새 파일을 failed 폴더로 옮겼습니다: $rel"
                    Move-FileStrict $backup $target
                    Write-Log "롤백: 백업에서 원본을 복원했습니다: $rel"
                    $settled = $true
                } else {
                    Write-Log "롤백: 제자리에 알 수 없는 내용의 파일이 있어 건드리지 않습니다: $rel"
                }
            } else {
                if ($null -ne $targetHash -and $targetHash -eq $item.oldHash) {
                    Write-Log "롤백: 원본이 제자리에 그대로 있습니다: $rel"
                    $settled = $true
                } elseif ($null -eq $targetHash) {
                    Write-Log "롤백: 원본도 백업도 없어 복원하지 못했습니다: $rel"
                } else {
                    Write-Log "롤백: 백업이 없어 제자리 파일을 그대로 둡니다: $rel"
                }
            }
        } else {
            if ($null -ne $backupHash) {
                Write-Log "롤백: 원본이 없던 항목에 백업이 있어 건드리지 않습니다: $rel"
            } elseif ($null -eq $targetHash) {
                $settled = $true
            } elseif ($targetHash -eq $item.newHash) {
                $failedPath = Get-UniquePath (Get-RelativeTarget $failedRoot $rel)
                Move-FileStrict $target $failedPath
                Write-Log "롤백: 새 파일을 failed 폴더로 옮겼습니다: $rel"
                $settled = $true
            } else {
                Write-Log "롤백: 알 수 없는 내용의 파일이라 건드리지 않습니다: $rel"
            }
        }

        if ($settled) {
            $ok = $false
            if ($item.existed) { $ok = (Test-RegularFile $target) -and ((Get-FileSha256 $target) -eq $item.oldHash) }
            else { $ok = -not ([System.IO.File]::Exists($target) -or [System.IO.Directory]::Exists($target)) }
            if ($ok) {
                $item.entry.phase = 'restored'
                Write-AtomicJson $journalPath $journal
            } else {
                Write-Log "롤백: 되돌린 뒤 확인에 실패했습니다: $rel"
                $mixed = $true
            }
        } else {
            $mixed = $true
        }
    }

    # 최종 검증: 저널 단계와 무관하게 모든 항목이 원본 상태여야 rolled_back 이다.
    foreach ($item in $items) {
        if ($item.existed) {
            if (-not (Test-RegularFile $item.target) -or ((Get-FileSha256 $item.target) -ne $item.oldHash)) {
                Write-Log "롤백 최종 검증 실패: 원본이 제자리에 없거나 해시가 다릅니다: $($item.rel)"
                $mixed = $true
            }
        } elseif ([System.IO.File]::Exists($item.target) -or [System.IO.Directory]::Exists($item.target)) {
            Write-Log "롤백 최종 검증 실패: 원래 없던 파일이 남아 있습니다: $($item.rel)"
            $mixed = $true
        }
    }
    if ($mixed) { return 'mixed' }
    return 'rolled_back'
}

# ---------------------------------------------------------------- 경로 검증 (두 동작 공통)
try {
    $AppDir = [System.IO.Path]::GetFullPath($AppDir).TrimEnd('\')
    if ($AppDir.StartsWith('\\')) { throw "네트워크 경로(UNC)에서는 업데이트하지 않습니다: $AppDir" }
    if ($AppDir -notmatch '^[A-Za-z]:\\') { throw "드라이브 문자로 시작하는 경로만 지원합니다: $AppDir" }
    $appRoot = [System.IO.Path]::GetPathRoot($AppDir)
    if ([string]::Equals($AppDir.TrimEnd('\'), $appRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { throw "드라이브 최상위 폴더는 업데이트 대상이 될 수 없습니다: $AppDir" }
    Assert-DirectoryChain $AppDir '앱 폴더'

    $updateBase = Join-Path $AppDir '.aiplaygrand-update'
    $StageDir = [System.IO.Path]::GetFullPath($StageDir).TrimEnd('\')
    $script:UpdateId = [System.IO.Path]::GetFileName($StageDir)
    if ($script:UpdateId -notmatch $script:UuidRegex) { throw "스테이지 폴더 이름이 UUID가 아닙니다: $StageDir" }
    $expectedStage = Join-Path $updateBase $script:UpdateId
    if (-not [string]::Equals($StageDir, $expectedStage, [StringComparison]::OrdinalIgnoreCase)) { throw "스테이지 폴더가 앱 폴더의 .aiplaygrand-update\<UUID> 위치가 아닙니다: $StageDir" }
    Assert-DirectoryChain $StageDir '스테이지 폴더'
    $script:LogPath = Join-Path $StageDir 'update.log'
} catch {
    # 로그 경로가 정해지기 전이므로 stderr 로만 알린다(앱은 준비 시간 초과·조기 종료로 감지한다).
    [Console]::Error.WriteLine("경로 검증 실패: $($_.Exception.Message)")
    exit 1
}

$journalPath = Join-Path $StageDir 'update-journal.json'
$exePath = Join-Path $AppDir 'AIplaygrand-Win.exe'

# ================================================================ Recover
if ($Action -eq 'Recover') {
    try {
        Write-Log "수동 복구(Recover)를 시작합니다."
        $journal = $null
        try { $journal = Read-JsonFile $journalPath } catch {
            $prevPath = [System.IO.Path]::ChangeExtension($journalPath, '.prev.json')
            Write-Log "저널을 읽지 못해 직전 저널을 사용합니다: $($_.Exception.Message)"
            $journal = Read-JsonFile $prevPath
        }
        if ((Get-Prop $journal 'updateId') -ne $script:UpdateId) { throw "저널의 업데이트 ID가 스테이지 폴더와 다릅니다." }
        if (-not [string]::Equals([string](Get-Prop $journal 'appDir'), $AppDir, [StringComparison]::OrdinalIgnoreCase)) { throw "저널의 앱 폴더가 지정한 폴더와 다릅니다." }
        $status = [string](Get-Prop $journal 'status')
        if ($status -eq 'committed') { Write-Log "저널 상태가 committed 입니다. 교체가 완료된 업데이트이므로 되돌리지 않습니다."; exit 0 }
        if ($status -eq 'prepared') { Write-Log "저널 상태가 prepared 입니다. 앱 파일은 바뀌지 않았으므로 복구할 것이 없습니다."; exit 0 }
        if ($status -notin @('applying', 'rolled_back', 'rollback_failed', 'mixed')) { throw "알 수 없는 저널 상태입니다: $status" }
        $targets = @()
        foreach ($entry in @(Get-Prop $journal 'files')) {
            $rel = [string](Get-Prop $entry 'rel')
            if (Test-ManagedRelativePath $rel) { $targets += (Get-RelativeTarget $AppDir $rel) }
        }
        Write-Log "복구 전 파일 잠금을 확인합니다. AIplaygrand-Win 이 실행 중이면 먼저 닫아 주세요."
        Wait-FilesUnlocked $targets
        $script:Phase = 'mutating'
        $outcome = 'rollback_failed'
        try { $outcome = Invoke-Rollback $journal $journalPath } catch { Write-Log "롤백 중 예외: $($_.Exception.Message)" }
        $journal.status = $outcome
        Write-AtomicJson $journalPath $journal
        Write-Result $outcome ([string](Get-Prop $journal 'targetVersion')) ("수동 복구 결과: " + $outcome)
        Write-Log "복구 결과: $outcome"
        if ($outcome -eq 'rolled_back') { Write-Host "이전 버전으로 복원되었습니다. 앱을 직접 실행해 확인하세요."; exit 0 }
        Write-Host "일부 파일을 복원하지 못했습니다(상태: $outcome). update.log 와 backup\ 폴더를 확인하세요. 백업 파일은 지우지 않았습니다."
        exit 1
    } catch {
        Write-Log "복구 실패: $($_.Exception.Message)"
        Write-Host "복구 실패: $($_.Exception.Message)"
        exit 1
    }
}

# ================================================================ Apply
$journal = $null
$targetVersion = ''
try {
    Write-Log "업데이트 적용(Apply)을 시작합니다. ParentPid=$ParentPid PID=$PID"
    if ($ParentPid -le 0) { throw "부모 프로세스 PID가 필요합니다." }
    if ([System.IO.File]::Exists($journalPath)) { throw "이 스테이지에는 이미 저널이 있어 재사용하지 않습니다." }
    if ([System.IO.File]::Exists((Join-Path $StageDir 'apply-cancelled.json'))) { throw "취소 마커가 있어 시작하지 않습니다." }

    # ---- 메타데이터
    $meta = Read-JsonFile (Join-Path $StageDir 'update-meta.json')
    if ((Get-Prop $meta 'updateId') -ne $script:UpdateId) { throw "메타데이터의 업데이트 ID가 스테이지 폴더와 다릅니다." }
    $targetVersion = [string](Get-Prop $meta 'version')
    if ($targetVersion -notmatch $script:SemverRegex) { throw "메타데이터의 버전 형식이 올바르지 않습니다." }
    $zipFileName = [string](Get-Prop $meta 'zipFileName')
    if ($zipFileName -cne "AIplaygrand-Win-$targetVersion-x64.zip") { throw "메타데이터의 ZIP 파일 이름이 버전과 맞지 않습니다." }
    $expectedSha = ([string](Get-Prop $meta 'expectedSha256')).ToLowerInvariant()
    if ($expectedSha -notmatch $script:Sha256Regex) { throw "메타데이터의 SHA-256 형식이 올바르지 않습니다." }
    $assetSize = [int64](Get-Prop $meta 'assetSize')
    if ($assetSize -lt $script:MinZipBytes -or $assetSize -gt $script:MaxZipBytes) { throw "메타데이터의 ZIP 크기가 허용 범위를 벗어났습니다." }
    if (-not [string]::Equals([string](Get-Prop $meta 'appDir'), $AppDir, [StringComparison]::OrdinalIgnoreCase)) { throw "메타데이터의 앱 폴더가 실행 인자와 다릅니다." }
    if ([int](Get-Prop $meta 'parentPid') -ne $ParentPid) { throw "메타데이터의 부모 PID가 실행 인자와 다릅니다." }

    # ---- ZIP 파일
    $zipPath = Join-Path $StageDir $zipFileName
    if (-not (Test-RegularFile $zipPath)) { throw "ZIP 파일이 없거나 일반 파일이 아닙니다." }
    if ((New-Object System.IO.FileInfo($zipPath)).Length -ne $assetSize) { throw "ZIP 파일 크기가 메타데이터와 다릅니다." }
    Write-Log "ZIP SHA-256 을 다시 계산합니다."
    if ((Get-FileSha256 $zipPath) -ne $expectedSha) { throw "ZIP SHA-256 이 메타데이터와 다릅니다." }

    # ---- ZIP 항목 검사 (허용 목록 고정, 링크·디렉터리·중복·크기)
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $plan = New-Object System.Collections.ArrayList
    $seen = @{}
    $totalUnpacked = [int64]0
    $localeCount = 0
    $hasExe = $false
    $hasAsar = $false
    $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        if ($zip.Entries.Count -gt $script:MaxZipEntries) { throw "ZIP 항목 수가 허용 기준($($script:MaxZipEntries))을 넘습니다." }
        foreach ($entry in $zip.Entries) {
            $rawName = [string]$entry.FullName
            if ($rawName.Length -gt 200) { throw "ZIP 항목 이름이 너무 깁니다." }
            $norm = $rawName.Replace('\', '/')
            $extProp = $entry.PSObject.Properties['ExternalAttributes']
            if ($null -eq $extProp) { throw "이 PC의 .NET Framework 가 ZIP 항목 속성(ExternalAttributes)을 지원하지 않아 링크 항목을 검사할 수 없습니다. 자체 업데이트에는 .NET Framework 4.7.2 이상과 Windows PowerShell 5.1 이 필요합니다. ZIP 을 직접 내려받아 교체하세요." }
            $ext = [int64]$entry.ExternalAttributes
            if ($ext -lt 0) { $ext += 4294967296 }
            $unixMode = ($ext -shr 16) -band 0xF000
            if ($unixMode -eq 0xA000) { throw "심볼릭 링크 항목은 허용하지 않습니다: $rawName" }
            if (($ext -band 0x400) -ne 0) { throw "reparse point 속성 항목은 허용하지 않습니다: $rawName" }
            if ($norm.EndsWith('/')) {
                $dirName = $norm.TrimEnd('/')
                if ($dirName -cne 'locales' -and $dirName -cne 'resources') { throw "허용되지 않은 폴더 항목입니다: $rawName" }
                continue
            }
            if (-not (Test-ManagedRelativePath $norm)) { throw "관리 대상 목록에 없는 항목이 있어 중단합니다: $rawName" }
            $lower = $norm.ToLowerInvariant()
            if ($seen.ContainsKey($lower)) { throw "ZIP 안에 대소문자만 다른 중복 항목이 있습니다: $rawName" }
            $seen[$lower] = $true
            if ($entry.Length -lt 0 -or $entry.Length -gt $script:MaxSingleFileBytes) { throw "단일 파일 크기가 한도를 넘습니다: $rawName" }
            $totalUnpacked += [int64]$entry.Length
            if ($totalUnpacked -gt $script:MaxTotalUnpackedBytes) { throw "압축 해제 총 크기가 한도를 넘습니다." }
            if ($norm.StartsWith('locales/')) { $localeCount++; if ($localeCount -gt $script:MaxLocaleFiles) { throw "locales 파일 수가 한도를 넘습니다." } }
            if ($norm -ceq 'AIplaygrand-Win.exe') { $hasExe = $true }
            if ($norm -ceq 'resources/app.asar') { $hasAsar = $true }
            [void]$plan.Add([pscustomobject]@{ rel = $norm; length = [int64]$entry.Length })
        }
        if (-not $hasExe) { throw "ZIP 에 AIplaygrand-Win.exe 가 없습니다." }
        if (-not $hasAsar) { throw "ZIP 에 resources/app.asar 가 없습니다." }
        if ($plan.Count -eq 0) { throw "ZIP 에 파일이 없습니다." }

        # ---- 여유 공간 (압축 해제분 + 여유. 백업은 같은 볼륨 내 이동이라 추가 공간이 거의 들지 않는다)
        $drive = New-Object System.IO.DriveInfo($appRoot)
        $required = $totalUnpacked + 64MB
        if ($drive.AvailableFreeSpace -lt $required) { throw "USB 여유 공간이 부족합니다. 필요 약 $([math]::Ceiling($required / 1MB))MB, 남은 공간 약 $([math]::Floor($drive.AvailableFreeSpace / 1MB))MB." }

        # ---- 압축 해제 (항목별, 검증된 상대 경로로만)
        $extractDir = Join-Path $StageDir 'extracted'
        if ([System.IO.Directory]::Exists($extractDir) -or [System.IO.File]::Exists($extractDir)) { throw "extracted 폴더가 이미 있어 재사용하지 않습니다." }
        [void][System.IO.Directory]::CreateDirectory($extractDir)
        Write-Log "ZIP 항목 $($plan.Count)개를 extracted 폴더에 풉니다."
        foreach ($item in $plan) {
            $entry = $zip.GetEntry($item.rel)
            if ($null -eq $entry) { $entry = $zip.GetEntry($item.rel.Replace('/', '\')) }
            if ($null -eq $entry) { throw "ZIP 항목을 다시 찾지 못했습니다: $($item.rel)" }
            $dest = Get-RelativeTarget $extractDir $item.rel
            Ensure-Directory ([System.IO.Path]::GetDirectoryName($dest))
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $false)
        }
    } finally { $zip.Dispose() }

    # ---- 압축 해제 결과 검증: 개수·크기·reparse, 해시 기록
    $extractedFiles = @(Get-ChildItem -LiteralPath $extractDir -Recurse -File -Force)
    if ($extractedFiles.Count -ne $plan.Count) { throw "압축 해제된 파일 수($($extractedFiles.Count))가 항목 수($($plan.Count))와 다릅니다." }
    foreach ($dirItem in @(Get-ChildItem -LiteralPath $extractDir -Recurse -Directory -Force)) {
        if (Test-ReparsePoint $dirItem.FullName) { throw "압축 해제 결과에 정션·링크 폴더가 있습니다." }
    }
    $files = New-Object System.Collections.ArrayList
    foreach ($item in $plan) {
        $src = Get-RelativeTarget $extractDir $item.rel
        if (-not (Test-RegularFile $src)) { throw "압축 해제된 파일이 일반 파일이 아닙니다: $($item.rel)" }
        if ((New-Object System.IO.FileInfo($src)).Length -ne $item.length) { throw "압축 해제된 파일 크기가 ZIP 항목과 다릅니다: $($item.rel)" }
        [void]$files.Add([pscustomobject]@{ rel = $item.rel; newHash = (Get-FileSha256 $src); newSize = $item.length; existed = $false; oldHash = ''; oldSize = [int64]0; phase = 'pending' })
    }

    # ---- 저널 'prepared' (앱 파일은 아직 손대지 않음) + 준비 완료 신호
    $journal = [pscustomobject]@{
        journalVersion = 1
        status = 'prepared'
        updateId = $script:UpdateId
        appDir = $AppDir
        targetVersion = $targetVersion
        helperPid = $PID
        preparedAt = (Get-Date).ToString('o')
        appliedAt = ''
        committedAt = ''
        error = ''
        files = @($files.ToArray())
    }
    Write-AtomicJson $journalPath $journal
    $script:ReadyAt = Get-Date
    Write-AtomicJson (Join-Path $StageDir 'helper-ready.json') ([pscustomobject]@{ ready = $true; updateId = $script:UpdateId; helperPid = $PID; version = $targetVersion; at = $script:ReadyAt.ToString('o') })
    Write-Log "준비를 마쳤습니다. 앱의 승인 마커와 종료를 기다립니다."
    $script:Phase = 'waiting'

    # ---- 승인 대기: apply-authorized.json 과 부모 종료를 모두 확인. 취소·승인 없는 종료는 아무것도 바꾸지 않는다.
    $authPath = Join-Path $StageDir 'apply-authorized.json'
    $cancelPath = Join-Path $StageDir 'apply-cancelled.json'
    $auth = $null
    $waitDeadline = (Get-Date).AddSeconds($script:AuthWaitMaxSeconds)
    while ($true) {
        if ([System.IO.File]::Exists($cancelPath)) { Write-Log "취소 마커를 확인했습니다. 아무것도 바꾸지 않고 끝냅니다."; Write-Result 'cancelled' $targetVersion ''; exit 0 }
        if ([System.IO.File]::Exists($authPath)) {
            try { $auth = Read-JsonFile $authPath } catch { $auth = $null }
            if ($null -ne $auth) { break }
        }
        if (-not (Test-ParentRunning)) { Write-Log "승인 없이 앱이 종료되어 아무것도 바꾸지 않고 끝냅니다."; Write-Result 'cancelled' $targetVersion ''; exit 0 }
        if ((Get-Date) -gt $waitDeadline) { throw "승인을 기다리는 시간이 너무 길어져 중단했습니다." }
        Start-Sleep -Seconds 1
    }
    if ((Get-Prop $auth 'authorized') -ne $true) { throw "승인 마커가 유효하지 않습니다." }
    if ((Get-Prop $auth 'updateId') -ne $script:UpdateId) { throw "승인 마커의 업데이트 ID가 다릅니다." }
    if ([string](Get-Prop $auth 'version') -ne $targetVersion) { throw "승인 마커의 버전이 다릅니다." }
    if ([int](Get-Prop $auth 'parentPid') -ne $ParentPid) { throw "승인 마커의 부모 PID가 다릅니다." }
    if ([int](Get-Prop $auth 'helperPid') -ne $PID) { throw "승인 마커가 이 도우미를 가리키지 않습니다." }
    if (-not [string]::Equals([string](Get-Prop $auth 'appDir'), $AppDir, [StringComparison]::OrdinalIgnoreCase)) { throw "승인 마커의 앱 폴더가 다릅니다." }
    $authAt = [DateTimeOffset]::Parse([string](Get-Prop $auth 'authorizedAt'), [System.Globalization.CultureInfo]::InvariantCulture)
    $authAge = [DateTimeOffset]::UtcNow - $authAt.ToUniversalTime()
    if ($authAge.TotalMinutes -gt $script:AuthMaxAgeMinutes -or $authAge.TotalMinutes -lt -5) { throw "승인 마커가 오래되었거나 시각이 맞지 않습니다." }
    if ($authAt.LocalDateTime -lt $script:ReadyAt.AddMinutes(-1)) { throw "승인 마커가 준비 완료 이전에 만들어졌습니다." }
    Write-Log "승인 마커를 확인했습니다. 앱 프로세스($ParentPid) 종료를 기다립니다."

    $exitDeadline = (Get-Date).AddSeconds($script:ParentExitWaitSeconds)
    while (Test-ParentRunning) {
        if ((Get-Date) -gt $exitDeadline) { throw "앱이 $($script:ParentExitWaitSeconds)초 안에 종료되지 않아 교체를 중단했습니다. 기존 파일은 그대로입니다." }
        Start-Sleep -Milliseconds 500
    }
    if ([System.IO.File]::Exists($cancelPath)) { Write-Log "종료 직전 취소 마커가 있어 아무것도 바꾸지 않습니다."; Write-Result 'cancelled' $targetVersion ''; exit 0 }

    # ---- 교체 전 재검증: 스테이지 파일 해시, 대상 상태, 잠금
    $backupRoot = Join-Path $StageDir 'backup'
    if ([System.IO.Directory]::Exists($backupRoot) -or [System.IO.File]::Exists($backupRoot)) { throw "backup 폴더가 이미 있어 재사용하지 않습니다." }
    $targets = @()
    foreach ($entry in $journal.files) {
        $src = Get-RelativeTarget $extractDir $entry.rel
        if (-not (Test-RegularFile $src)) { throw "준비된 파일이 사라졌습니다: $($entry.rel)" }
        if ((Get-FileSha256 $src) -ne $entry.newHash) { throw "준비된 파일의 해시가 저널과 다릅니다: $($entry.rel)" }
        $target = Get-RelativeTarget $AppDir $entry.rel
        $parent = [System.IO.Path]::GetDirectoryName($target)
        if ([System.IO.Directory]::Exists($parent) -and (Test-ReparsePoint $parent)) { throw "대상 폴더가 정션·링크라 교체하지 않습니다: $parent" }
        if ([System.IO.Directory]::Exists($target)) { throw "대상 자리에 폴더가 있어 교체하지 않습니다: $($entry.rel)" }
        if ([System.IO.File]::Exists($target)) {
            if (Test-ReparsePoint $target) { throw "대상 파일이 링크라 교체하지 않습니다: $($entry.rel)" }
            $entry.existed = $true
            $entry.oldHash = Get-FileSha256 $target
            $entry.oldSize = (New-Object System.IO.FileInfo($target)).Length
            $targets += $target
        }
    }
    Write-Log "파일 잠금을 확인합니다."
    Wait-FilesUnlocked (@($exePath) + $targets)

    # ---- 교체 트랜잭션
    $script:Phase = 'mutating'
    $journal.status = 'applying'
    $journal.appliedAt = (Get-Date).ToString('o')
    Write-AtomicJson $journalPath $journal
    # 각 이동의 '직전'에 의도 단계를 저널에 먼저 쓴다. 이동 뒤 단계를 쓰기 전에 전원이 끊겨도 롤백은 저널 단계가 아니라
    # 실제 파일·백업 해시로 상태를 판정하므로(Invoke-Rollback) 여기서 단계 값은 진단·로그 용도다.
    Write-Log "원본 파일을 backup 폴더로 옮깁니다."
    foreach ($entry in $journal.files) {
        if (-not $entry.existed) { $entry.phase = 'backed_up'; Write-AtomicJson $journalPath $journal; continue }
        $entry.phase = 'backing_up'
        Write-AtomicJson $journalPath $journal
        Move-FileStrict (Get-RelativeTarget $AppDir $entry.rel) (Get-RelativeTarget $backupRoot $entry.rel)
        $entry.phase = 'backed_up'
        Write-AtomicJson $journalPath $journal
    }
    Write-Log "새 파일을 제자리로 옮깁니다."
    foreach ($entry in $journal.files) {
        $entry.phase = 'placing'
        Write-AtomicJson $journalPath $journal
        Move-FileStrict (Get-RelativeTarget $extractDir $entry.rel) (Get-RelativeTarget $AppDir $entry.rel)
        $entry.phase = 'placed'
        Write-AtomicJson $journalPath $journal
    }
    Write-Log "설치된 파일 해시를 검증합니다."
    foreach ($entry in $journal.files) {
        $target = Get-RelativeTarget $AppDir $entry.rel
        if (-not (Test-RegularFile $target)) { throw "설치 후 파일이 없습니다: $($entry.rel)" }
        if ((Get-FileSha256 $target) -ne $entry.newHash) { throw "설치 후 해시가 다릅니다: $($entry.rel)" }
    }
    $journal.status = 'committed'
    $journal.committedAt = (Get-Date).ToString('o')
    Write-AtomicJson $journalPath $journal
    $script:Phase = 'done'
    try { [System.IO.File]::Delete($authPath) } catch {}
    Write-Result 'success' $targetVersion ''
    Write-Log "v$targetVersion 업데이트를 완료했습니다. 앱을 다시 시작합니다. 원본은 backup 폴더에 남아 있습니다."
    Start-Process -FilePath $exePath -WorkingDirectory $AppDir
    exit 0
} catch {
    $errorText = $_.Exception.Message
    Write-Log "오류: $errorText (단계: $($script:Phase))"
    if ($script:Phase -eq 'done') {
        Write-Log "재시작에 실패했지만 교체는 이미 완료되었습니다: $errorText"
        Show-Alert 'AIplaygrand-Win 업데이트 완료' "업데이트는 완료되었지만 앱을 자동으로 다시 시작하지 못했습니다. 앱을 직접 실행하세요.`n오류: $errorText"
        exit 0
    }
    if ($script:Phase -eq 'preflight') {
        Write-Result 'prepare_failed' $targetVersion $errorText
        exit 1
    }
    if ($script:Phase -eq 'waiting') {
        Write-Result 'aborted' $targetVersion $errorText
        try { [System.IO.File]::Delete((Join-Path $StageDir 'apply-authorized.json')) } catch {}
        Show-Alert 'AIplaygrand-Win 업데이트 중단' "업데이트를 시작하지 못했습니다. 기존 파일은 바뀌지 않았습니다.`n$errorText`n앱을 직접 다시 실행하세요."
        exit 1
    }
    # 교체 도중 실패: 저널 기반 롤백
    $outcome = 'rollback_failed'
    try {
        if ($null -ne $journal) { $outcome = Invoke-Rollback $journal $journalPath }
    } catch { Write-Log "롤백 중 예외: $($_.Exception.Message)" }
    try {
        if ($null -ne $journal) { $journal.status = $outcome; $journal.error = $errorText; Write-AtomicJson $journalPath $journal }
    } catch { Write-Log "롤백 저널 기록 실패: $($_.Exception.Message)" }
    try { [System.IO.File]::Delete((Join-Path $StageDir 'apply-authorized.json')) } catch {}
    Write-Result $outcome $targetVersion $errorText
    if ($outcome -eq 'rolled_back' -and (Test-RegularFile $exePath)) {
        Write-Log "이전 버전으로 완전히 복원되었습니다. 이전 버전을 다시 시작합니다."
        Show-Alert 'AIplaygrand-Win 업데이트 실패' "업데이트를 완료하지 못해 이전 버전으로 되돌렸습니다. Data·Tools 폴더는 그대로입니다.`n오류: $errorText"
        Start-Process -FilePath $exePath -WorkingDirectory $AppDir
    } else {
        Write-Log "복원이 완전하지 않아(상태: $outcome) 앱을 자동으로 다시 시작하지 않습니다."
        Show-Alert 'AIplaygrand-Win 업데이트 복구 필요' "업데이트 중 오류가 났고 자동 복원이 완전하지 않습니다(상태: $outcome). Data·Tools 폴더는 그대로입니다.`n앱을 실행하기 전에 다음 폴더의 update.log 와 backup 폴더를 확인하거나, 이 스크립트를 -Action Recover 로 다시 실행하세요:`n$StageDir`n오류: $errorText"
    }
    exit 1
}
