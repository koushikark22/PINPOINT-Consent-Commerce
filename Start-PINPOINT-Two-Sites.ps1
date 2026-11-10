param([ValidateSet("mock","sandbox")][string]$PaymentMode="mock")
$ErrorActionPreference="Stop"
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$python=Join-Path $root ".venv\Scripts\python.exe"
if (!(Test-Path $python)) {$python="python"}
$env:PAYMENT_MODE=$PaymentMode
if ($PaymentMode -eq 'mock') { $env:PUBLIC_MOCK_JUDGE_MODE='1' } else { $env:PUBLIC_MOCK_JUDGE_MODE='0' }
Set-Location $root
# Two foreground processes; PowerShell job cleanup when terminal closes.
$backend=Start-Process -FilePath $python -ArgumentList @('-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8877') -PassThru
Start-Sleep -Seconds 3
try { & $python 'market_site/server.py' } finally { Stop-Process -Id $backend.Id -ErrorAction SilentlyContinue }
