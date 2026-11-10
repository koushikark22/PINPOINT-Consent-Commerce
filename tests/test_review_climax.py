"""Offline verification: two independent authorizations, one held and voided by signer."""
from datetime import datetime,timezone
from fastapi.testclient import TestClient
from app.main import app
from app import crypto,ai
from tests.test_api import ADMIN


def test_sibling_capture_and_order_specific_signed_void(monkeypatch):
    async def fake_extract(text):
        return {'mode':'LIVE_LLM','model':'test-double-not-real-ai','claims':{'sku':'TWO-ORDERS' if 'Handmade' in text else 'WRONG-SKU','price_usd':49 if 'Handmade' in text else 99,'merchant':None}}
    monkeypatch.setattr(ai,'extract_claims',fake_extract)
    private,public=crypto.generate_key()
    with TestClient(app) as c:
        r=c.post('/api/policies',headers=ADMIN,json={'sku':'TWO-ORDERS','creator_public_key':public,'creator_label':'Dana Cole'})
        assert r.status_code==200,r.text
        obj=r.json();pid=obj['id']
        assert c.post(f'/api/policies/{pid}/activate',json={'signature':crypto.sign(private,obj['payload'])}).status_code==200
        def buy(tag):
            x=c.post('/api/checkouts',json={'policy_id':pid,'amount':'49.00','sku':'TWO-ORDERS','domain':'localhost','content_id':tag})
            assert x.status_code==200,x.text
            t=x.json()['payment_id']
            assert c.post(f'/api/mock-approve/{t}').status_code==200
            assert c.post(f'/api/payments/{t}/authorize').status_code==200
            return t
        clean=buy('original-video')
        suspicious=buy('cloned-video')
        analysis=c.post(f'/api/payments/{suspicious}/analyze-review',headers=ADMIN,json={'content_id':'cloned-video','transcript':'This is a different product for $99'})
        assert analysis.status_code==200,analysis.text
        assert analysis.json()['state']=='HELD_FOR_REVIEW'
        assert c.post(f'/api/payments/{suspicious}/settle',headers=ADMIN).status_code==409
        assert c.post(f'/api/payments/{clean}/settle',headers=ADMIN).json()['state']=='CAPTURED'
        at=datetime.now(timezone.utc).isoformat()
        rec={'payment_id':suspicious,'policy_id':pid,'action':'VOID','reason':'The cited clone does not match the endorsement','time':at}
        bad=c.post(f'/api/payments/{suspicious}/creator-review',headers=ADMIN,json={'action':rec['action'],'reason':rec['reason'],'creator_time':at,'creator_signature':'wrong'})
        assert bad.status_code==403
        decision=c.post(f'/api/payments/{suspicious}/creator-review',headers=ADMIN,json={'action':rec['action'],'reason':rec['reason'],'creator_time':at,'creator_signature':crypto.sign(private,rec)})
        assert decision.status_code==200,decision.text
        assert decision.json()['state']=='VOIDED'
        proof=c.post(f'/api/lab/{suspicious}/capture-after-void',headers=ADMIN)
        assert proof.status_code==200,proof.text
        assert proof.json()['expected_refusal'] is True
        assert proof.json()['http_status']==422
        assert proof.json()['mode']=='mock'
        assert proof.json()['authorization_readback']['status']=='VOIDED'
        assert c.get(f'/api/payments/{clean}').json()['payment']['state']=='CAPTURED'


def test_held_order_timeout_void(monkeypatch):
    async def fake_extract(text):
        return {'mode':'LIVE_LLM','model':'test-double-not-real-ai','claims':{'sku':'TIMEOUT-ITEM' if 'Handmade' in text else 'X','price_usd':49 if 'Handmade' in text else 99}}
    monkeypatch.setattr(ai,'extract_claims',fake_extract)
    from app.main import resolve_review_timeout
    import asyncio
    with TestClient(app) as c:
        p=c.post('/api/policies',headers=ADMIN,json={'sku':'TIMEOUT-ITEM'}).json()
        x=c.post('/api/checkouts',json={'policy_id':p['id'],'sku':'TIMEOUT-ITEM','amount':'49.00','domain':'localhost','content_id':'clone'}).json()
        tid=x['payment_id'];c.post(f'/api/mock-approve/{tid}');c.post(f'/api/payments/{tid}/authorize')
        assert c.post(f'/api/payments/{tid}/analyze-review',headers=ADMIN,json={'content_id':'clone','transcript':'different product'}).json()['held']
        # The timeout is a CREATOR-SIGNED policy term: emulate elapsed time explicitly.
        from app import store
        from datetime import timedelta
        with store.tx() as conn:
            old=(datetime.now(timezone.utc)-timedelta(seconds=130)).isoformat()
            conn.execute('UPDATE payment SET review_since=? WHERE id=?',(old,tid))
        outcome=asyncio.run(resolve_review_timeout(tid))
        assert outcome['state']=='VOIDED'
        assert c.get(f'/api/payments/{tid}').json()['paypal_readback']['status']=='VOIDED'


def test_ai_unavailable_does_not_fabricate_hold(monkeypatch):
    async def unavailable(text):return {'mode':'UNAVAILABLE','claims':None}
    monkeypatch.setattr(ai,'extract_claims',unavailable)
    with TestClient(app) as c:
        p=c.post('/api/policies',headers=ADMIN,json={'sku':'AI-OFF'}).json()
        x=c.post('/api/checkouts',json={'policy_id':p['id'],'sku':'AI-OFF','amount':'49.00','domain':'localhost','content_id':'clone'}).json()
        tid=x['payment_id'];c.post(f'/api/mock-approve/{tid}');c.post(f'/api/payments/{tid}/authorize')
        a=c.post(f'/api/payments/{tid}/analyze-review',headers=ADMIN,json={'content_id':'clone','transcript':'foo'})
        assert a.json()['held'] is False
        assert c.get(f'/api/payments/{tid}').json()['payment']['state']=='AUTHORIZED'
