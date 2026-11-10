"""Verify outgoing PayPal request shape without pretending to contact PayPal."""
import asyncio
from app.paypal import SandboxGateway
from app.config import MERCHANT

def test_sandbox_order_contract_has_real_payee_pin(monkeypatch):
    monkeypatch.setenv('PAYPAL_CLIENT_ID','UNIT_TEST_NOT_REAL')
    monkeypatch.setenv('PAYPAL_CLIENT_SECRET','UNIT_TEST_NOT_REAL')
    client=SandboxGateway()
    requests=[]
    async def fake(method,path,body=None,request_id=None):
        requests.append((method,path,body,request_id))
        return {'id':'FAKE-ORDER','links':[]}
    monkeypatch.setattr(client,'request',fake)
    asyncio.run(client.create('4.00','SAMPLE-ITEM','create-unit-test'))
    method,path,body,request_id=requests[0]
    assert method=='POST' and path=='/v2/checkout/orders'
    assert body['intent']=='AUTHORIZE'
    assert len(body['purchase_units'])==1
    assert body['purchase_units'][0]['payee']['merchant_id']==MERCHANT
    assert body['purchase_units'][0]['reference_id']=='SAMPLE-ITEM'
    assert request_id=='create-unit-test'


def test_phash_mirror_is_perceptual_and_not_ai():
    from PIL import Image,ImageDraw,ImageOps
    from app.ai import phash,hd
    image=Image.new('RGB',(128,128),'black')
    ImageDraw.Draw(image).ellipse((10,40,60,100),fill='white')
    mirror=ImageOps.mirror(image)
    assert phash(mirror)==phash(ImageOps.mirror(image))
    assert hd(phash(image),phash(image))==0
    assert len(phash(image))==64
