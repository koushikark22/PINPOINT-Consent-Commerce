import os
from pathlib import Path

# Load .env without an additional dependency.
def load_env():
    env = Path('.env')
    if not env.exists(): return
    for line in env.read_text(encoding='utf-8').splitlines():
        line=line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k,v=line.split('=',1)
        os.environ.setdefault(k.strip(),v.strip().strip('"').strip("'"))

load_env()
MODE=os.getenv('PAYMENT_MODE','mock').lower()
if MODE not in ('mock','sandbox'): raise ValueError('PAYMENT_MODE must be mock or sandbox')
ORIGIN=os.getenv('APP_ORIGIN','http://localhost:8000').rstrip('/')
DB_PATH=os.getenv('DB_PATH','./payee_pinning.sqlite3')
MERCHANT=os.getenv('PAYPAL_MERCHANT_ID','').strip() or ('MOCK_MERCHANT_001' if MODE=='mock' else '')
ADMIN_TOKEN=os.getenv('DEMO_ADMIN_TOKEN','replace-me-before-public-deploy')
