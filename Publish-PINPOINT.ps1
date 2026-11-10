$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = 'https://github.com/koushikark22/PINPOINT-Consent-Commerce.git'
$destination = Join-Path $HOME 'Desktop\PINPOINT_GitHub_Publish'

if (!(Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git is required. Install Git for Windows, reopen PowerShell, then rerun.'
}
if (!(Test-Path (Join-Path $source 'app\main.py'))) {
    throw 'Extract the release ZIP fully and run this script from the extracted folder.'
}
if (Test-Path $destination) {
    throw "A publishing folder already exists: $destination. Rename it to keep existing work safe."
}

git clone $repo $destination
if ($LASTEXITCODE -ne 0) { throw 'Git clone failed. Check GitHub sign-in.' }
Get-ChildItem -LiteralPath $source -Force | Where-Object { $_.Name -notin @('.git','.venv','__pycache__') } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
}
Set-Location $destination

# Ensure no unexpected project binary or local credentials are tracked.
$all = Get-ChildItem -Recurse -File -Force | Where-Object { $_.FullName -notmatch '[\\/]\.git[\\/]' }
$bad = $all | Where-Object {
    $_.Name -match '^(\.env|.*\.(db|sqlite|sqlite3|p12|pfx|pem|key))$' -or
    $_.FullName -match '[\\/](\.venv|venv|__pycache__|artifacts|logs)[\\/]'
}
if ($bad) { $bad | Select-Object -ExpandProperty FullName; throw 'Sensitive local files detected; nothing pushed.' }

# Check public-facing content and known API credential formats.
$pattern = '(?i)AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}'
$findings = $all | Where-Object { $_.Extension -match '^\.(py|js|html|css|md|yaml|yml|ps1|txt|json)$' } |
    Select-String -Pattern $pattern -ErrorAction SilentlyContinue
if ($findings) {
    $findings | Select-Object Path,LineNumber,Line | Format-Table -Wrap
    throw 'Publication review findings; nothing pushed.'
}

git add -A
if ($LASTEXITCODE -ne 0) { throw 'git add failed.' }
Write-Host "`nFiles being committed:" -ForegroundColor Cyan
git diff --cached --stat
$staged = @(git diff --cached --name-only)
if ($staged.Count -eq 0) { Write-Host 'No changes to publish.'; exit 0 }

git commit -m 'Publish PINPOINT Market and Scenario Studio source, tests, and free demo configuration'
if ($LASTEXITCODE -ne 0) { throw 'git commit failed; configure Git user.name and user.email locally.' }
git push origin main
if ($LASTEXITCODE -ne 0) { throw 'Git push failed. Repository has local committed files in the publishing folder.' }
Write-Host "`nPUBLISHED: https://github.com/koushikark22/PINPOINT-Consent-Commerce" -ForegroundColor Green
