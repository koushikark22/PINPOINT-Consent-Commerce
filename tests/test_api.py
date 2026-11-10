import os,tempfile
from pathlib import Path
os.environ['PAYMENT_MODE']='mock'
os.environ['DEMO_ADMIN_TOKEN']='test-token'
os.environ['DB_PATH']=str(Path(tempfile.gettempdir())/('pinpoint-test-'+str(os.getpid())+'.sqlite3'))
from fastapi.testclient import TestClient
from app.main import app
from app import store

ADMIN={'X-Demo-Token':'test-token'}

def test_full_lifecycle_and_revocation():
    with TestClient(app) as c:
        p=c.post('/api/policies',json={'sku':'DEMO-A','max_price_usd':'49.00'},headers=ADMIN).json()
        pid=p['id']
        wrong=c.post('/api/checkouts',json={'policy_id':pid,'sku':'DEMO-A','amount':'49.00','domain':'localhost','payee':'BAD_PAYEE'})
        assert wrong.status_code==409
        assert wrong.json()['paypal_order_created'] is False
        price=c.post('/api/checkouts',json={'policy_id':pid,'sku':'DEMO-A','amount':'99.00','domain':'localhost'})
        assert price.status_code==409
        def buy():
            r=c.post('/api/checkouts',json={'policy_id':pid,'sku':'DEMO-A','amount':'49.00','domain':'localhost'})
            assert r.status_code==200,r.text
            t=r.json()['payment_id']
            assert c.post('/api/mock-approve/'+t).status_code==200
            a=c.post(f'/api/payments/{t}/authorize')
            assert a.status_code==200,a.text
            return t
        first=buy()
        result=c.post('/api/payments/'+first+'/settle',headers=ADMIN)
        assert result.status_code==200,result.text
        assert result.json()['state']=='CAPTURED'
        second=buy()
        # Commercial termination does not auto-void existing authorizations
        r=c.post('/api/policies/'+pid+'/revoke',json={'revocation_class':'commercial','reason':'Agreement completed'},headers=ADMIN)
        assert r.json()['status']=='TERMINATED'
        result=c.post('/api/payments/'+second+'/settle',headers=ADMIN)
        assert result.json()['state']=='CAPTURED'
        assert c.post('/api/checkouts',json={'policy_id':pid,'sku':'DEMO-A','amount':'49.00','domain':'localhost'}).status_code==409
        # A broad fraud claim is review-only; arbitrary strings cannot void a sibling order
        p2=c.post('/api/policies',json={'sku':'DEMO-B'},headers=ADMIN).json()
        pid2=p2['id'];t=c.post('/api/checkouts',json={'policy_id':pid2,'sku':'DEMO-B','amount':'49.00','domain':'localhost'}).json()['payment_id']
        c.post('/api/mock-approve/'+t)
        c.post('/api/payments/'+t+'/authorize')
        rev=c.post('/api/policies/'+pid2+'/revoke',json={'revocation_class':'fraud','reason':'Merchant bait and switch','evidence':'Screenshot verified by creator showing price change'},headers=ADMIN)
        assert rev.status_code==200
        void=c.post('/api/payments/'+t+'/settle',headers=ADMIN)
        assert void.status_code==200,void.text
        assert rev.json()['status']=='REVIEW_REQUIRED'
        assert void.json()['state']=='CAPTURED'
        read=c.get('/api/payments/'+t).json()['paypal_readback']
        assert read['status']=='CAPTURED'
        again=c.post('/api/payments/'+t+'/settle',headers=ADMIN)
        assert again.json()['idempotent'] is True

def test_missing_evidence_fails_closed_for_fraud_revocation():
    with TestClient(app) as c:
        p=c.post('/api/policies',json={'sku':'SAFE'},headers=ADMIN).json()
        r=c.post('/api/policies/'+p['id']+'/revoke',json={'revocation_class':'fraud','reason':'Suspicion','evidence':''},headers=ADMIN)
        assert r.json()['status']=='REVIEW_REQUIRED'
        assert c.get('/api/policies').json()[0]['status']=='ACTIVE'

def test_concurrent_settlement_only_one_remote_operation():
    from concurrent.futures import ThreadPoolExecutor
    with TestClient(app) as c:
        p=c.post('/api/policies',json={'sku':'RACE'},headers=ADMIN).json()
        t=c.post('/api/checkouts',json={'policy_id':p['id'],'sku':'RACE','amount':'49.00','domain':'localhost'}).json()['payment_id']
        c.post('/api/mock-approve/'+t)
        c.post('/api/payments/'+t+'/authorize')
        def attempt(_):
            with TestClient(app) as thread_client:
                return thread_client.post('/api/payments/'+t+'/settle',headers=ADMIN)
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses=list(pool.map(attempt,range(2)))
        statuses=sorted(r.status_code for r in responses)
        assert statuses in ([200,409],[200,200]),[(r.status_code,r.text) for r in responses]
        event_rows=c.get('/api/events').json()
        assert sum(x['kind']=='PAYPAL_READBACK' and x['payment_id']==t for x in event_rows)==1
        assert c.get('/api/payments/'+t).json()['paypal_readback']['status']=='CAPTURED'
