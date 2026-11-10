import os,uuid,datetime,base64
from fastapi.testclient import TestClient
from app.main import app
from app import store,crypto

def test_browser_key_policy_and_signed_revocation():
    private,public=crypto.generate_key()
    with TestClient(app) as c:
        r=c.post('/api/policies',headers={'X-Demo-Token':'test-token'},json={'creator_label':'Judge','sku':'JUDGE-'+uuid.uuid4().hex[:6],'creator_public_key':public})
        assert r.status_code==200,r.text
        x=r.json();pid=x['id']
        assert x['signature'] is None
        invalid=c.post(f'/api/policies/{pid}/activate',json={'signature':'bad'})
        assert invalid.status_code==409
        signed=c.post(f'/api/policies/{pid}/activate',json={'signature':crypto.sign(private,x['payload'])})
        assert signed.json()['signature_valid']
        order=c.post('/api/checkouts',json={'policy_id':pid,'sku':x['payload']['sku'],'amount':'49.00','domain':'localhost'})
        assert order.status_code==200,order.text
        tid=order.json()['payment_id']
        c.post('/api/mock-approve/'+tid)
        assert c.post('/api/payments/'+tid+'/authorize').status_code==200
        time=datetime.datetime.now(datetime.timezone.utc).isoformat()
        rec={'policy_id':pid,'kind':'fraud','reason':'Changed offer','evidence':'A verified screenshot shows mismatch','time':time}
        bad=c.post(f'/api/policies/{pid}/revoke',headers={'X-Demo-Token':'test-token'},json={'revocation_class':'fraud','reason':rec['reason'],'evidence':rec['evidence'],'creator_time':time,'creator_signature':'bad'})
        assert bad.status_code==403
        rev=c.post(f'/api/policies/{pid}/revoke',headers={'X-Demo-Token':'test-token'},json={'revocation_class':'fraud','reason':rec['reason'],'evidence':rec['evidence'],'creator_time':time,'creator_signature':crypto.sign(private,rec)})
        assert rev.status_code==200,rev.text
        assert rev.json()['status']=='REVIEW_REQUIRED'
        assert c.get('/api/payments/'+tid).json()['paypal_readback']['status']=='CREATED'
