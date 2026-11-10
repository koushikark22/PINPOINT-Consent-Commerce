"""Content-level verdict is inherited by all subsequent orders; no name-only false hold."""
from fastapi.testclient import TestClient
from app.main import app
from app import ai,crypto
from tests.test_api import ADMIN


def test_product_label_variance_is_not_hard_mismatch():
    result=ai.compare_endorsements(
        {'product':'Handmade walnut stool','sku':'WOOD-1','price_usd':4},
        {'product':'handmade stool','sku':'WOOD-1','price_usd':4})
    assert result['status']=='CONSISTENT'
    assert result['notes']


def test_content_verdict_inherited_and_isolation(monkeypatch):
    calls=[]
    async def fake_extract(text):
        calls.append(text)
        mismatch='spoof' in text
        return {'mode':'LIVE_LLM','model':'unit-test-double','claims':
                {'product':'Handmade stool','sku':'FAKE-ITEM' if mismatch else 'WOOD-1',
                 'price_usd':4}}
    monkeypatch.setattr(ai,'extract_claims',fake_extract)
    private,public=crypto.generate_key()
    with TestClient(app) as c:
        response=c.post('/api/policies',headers=ADMIN,json={
            'creator_label':'Dana Cole','sku':'WOOD-1','max_price_usd':'4.00',
            'claims':'Handmade stool $4','review_timeout_seconds':180,
            'creator_public_key':public})
        assert response.status_code==200,response.text
        policy=response.json();pid=policy['id']
        assert policy['payload']['review_timeout_seconds']==180
        assert c.post(f'/api/policies/{pid}/activate',json={
            'signature':crypto.sign(private,policy['payload'])}).status_code==200
        def buy(content):
            result=c.post('/api/checkouts',json={'policy_id':pid,'sku':'WOOD-1',
                'amount':'4.00','domain':'localhost','content_id':content})
            assert result.status_code==200,result.text
            tid=result.json()['payment_id']
            assert c.post(f'/api/mock-approve/{tid}').status_code==200
            authorized=c.post(f'/api/payments/{tid}/authorize')
            assert authorized.status_code==200,authorized.text
            return tid,authorized.json()['state']
        first,_=buy('clone-x')
        clean,_=buy('original')
        flagged=c.post('/api/content/analyze',headers=ADMIN,json={
            'policy_id':pid,'content_id':'clone-x','transcript':'spoofed item'})
        assert flagged.status_code==200,flagged.text
        assert flagged.json()['content_verdict']=='MISMATCH'
        assert first in flagged.json()['affected_payment_ids']
        second,state=buy('clone-x')
        assert state=='HELD_FOR_REVIEW'
        assert c.post(f'/api/payments/{second}/settle',headers=ADMIN).status_code==409
        assert c.get(f'/api/payments/{clean}').json()['payment']['state']=='AUTHORIZED'
        assert c.post(f'/api/payments/{clean}/settle',headers=ADMIN).json()['state']=='CAPTURED'
        repeated=c.post('/api/content/analyze',headers=ADMIN,json={
            'policy_id':pid,'content_id':'clone-x','transcript':'Handmade stool $4'})
        assert repeated.json()['cached'] is True
        assert len(calls)==2  # cache avoids model reprocessing
