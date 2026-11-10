# PINPOINT - Windows setup + launch. Run from extracted repository folder.
$ErrorActionPreference='Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
if (!(Test-Path '.venv')) { py -3 -m venv .venv }
& '.\.venv\Scripts\python.exe' -m pip install -r requirements.txt
if (!(Test-Path '.env')) { Copy-Item '.env.example' '.env'; Write-Host 'Created .env. Edit your credentials and DEMO_ADMIN_TOKEN before any public deployment.' -ForegroundColor Yellow }
Write-Host 'Open http://localhost:8000; CTRL+C to stop' -ForegroundColor Cyan
& '.\.venv\Scripts\python.exe' -m uvicorn app.main:app --host 127.0.0.1 --port 8000
