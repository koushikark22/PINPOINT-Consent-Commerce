import sqlite3,json,datetime
from contextlib import contextmanager
from .config import DB_PATH

def utc():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def connect():
    c=sqlite3.connect(DB_PATH,timeout=12,check_same_thread=False,isolation_level=None)
    c.row_factory=sqlite3.Row
    c.execute('PRAGMA busy_timeout=12000')
    c.execute('PRAGMA journal_mode=WAL')
    return c
@contextmanager
def tx():
    c=connect()
    try:
        c.execute('BEGIN IMMEDIATE')
        yield c
        c.commit()
    except Exception:
        c.rollback();raise
    finally:c.close()
def init():
    with tx() as c:
        c.executescript('''
        CREATE TABLE IF NOT EXISTS creator(id TEXT PRIMARY KEY, public_key TEXT NOT NULL, private_key TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS policy(id TEXT PRIMARY KEY,creator_id TEXT NOT NULL,payload TEXT NOT NULL,signature TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'ACTIVE',created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS payment(id TEXT PRIMARY KEY,policy_id TEXT NOT NULL,order_id TEXT,authorization_id TEXT,amount TEXT NOT NULL,sku TEXT NOT NULL,payee TEXT NOT NULL,domain TEXT NOT NULL,state TEXT NOT NULL,policy_version INTEGER NOT NULL,request_id TEXT,api_response TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS content_verdict(policy_id TEXT NOT NULL,content_id TEXT NOT NULL,status TEXT NOT NULL,evidence TEXT NOT NULL,model TEXT,analyzed_at TEXT NOT NULL,PRIMARY KEY(policy_id,content_id));
        CREATE TABLE IF NOT EXISTS event(id INTEGER PRIMARY KEY AUTOINCREMENT,payment_id TEXT,policy_id TEXT,kind TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
        ''')
        columns={r['name'] for r in c.execute('PRAGMA table_info(payment)').fetchall()}
        for name,definition in {'content_id':'TEXT','review_reason':'TEXT','review_evidence':'TEXT','review_since':'TEXT'}.items():
            if name not in columns:c.execute(f'ALTER TABLE payment ADD COLUMN {name} {definition}')
def row(c,table,id):
    value=c.execute(f'SELECT * FROM {table} WHERE id=?',(id,)).fetchone()
    return dict(value) if value else None
def event(c,kind,details,payment=None,policy=None):
    c.execute('INSERT INTO event(payment_id,policy_id,kind,details,created_at) VALUES(?,?,?,?,?)',(payment,policy,kind,json.dumps(details,default=str),utc()))
