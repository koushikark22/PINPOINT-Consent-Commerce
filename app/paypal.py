"""Real PayPal REST sandbox adapter and clearly separated offline mock adapter.
PayPal integration is only executed when PAYMENT_MODE=sandbox and merchant credentials are supplied.
"""
import uuid,os,httpx,asyncio
from .config import MODE,ORIGIN,MERCHANT

class GatewayError(Exception):
    def __init__(self,code,details):
        super().__init__(str(details));self.code=code;self.details=details

class SandboxGateway:
    base='https://api-m.sandbox.paypal.com'
    def __init__(self):
        self.client=os.getenv('PAYPAL_CLIENT_ID','');self.secret=os.getenv('PAYPAL_CLIENT_SECRET','')
        if not self.client or not self.secret: raise GatewayError(503,'Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env')
    async def token(self):
        async with httpx.AsyncClient(timeout=25) as c:
            r=await c.post(self.base+'/v1/oauth2/token',auth=(self.client,self.secret),data={'grant_type':'client_credentials'})
        if r.status_code>=400: raise GatewayError(r.status_code,r.text)
        return r.json()['access_token']
    async def request(self,method,path,body=None,request_id=None):
        token=await self.token()
        headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}
        if request_id:headers['PayPal-Request-Id']=request_id
        async with httpx.AsyncClient(timeout=40) as c:
            r=await c.request(method,self.base+path,headers=headers,json=body)
        try:data=r.json()
        except ValueError:data={'raw':r.text}
        if r.status_code>=400:raise GatewayError(r.status_code,data)
        return data
    async def create(self,amount,sku,request_id):
        payload={'intent':'AUTHORIZE','purchase_units':[{'reference_id':sku,'payee':{'merchant_id':MERCHANT},'amount':{'currency_code':'USD','value':amount},'description':'Creator-pinned offer '+sku}], 'payment_source': {'paypal': {'experience_context': {'return_url':ORIGIN+'/?approved=1','cancel_url':ORIGIN+'/?cancelled=1','user_action':'PAY_NOW'}}}}
        return await self.request('POST','/v2/checkout/orders',payload,request_id)
    async def get_order(self,id):return await self.request('GET','/v2/checkout/orders/'+id)
    async def authorize(self,id,request_id):return await self.request('POST',f'/v2/checkout/orders/{id}/authorize',{},request_id)
    async def get_authorization(self,id):return await self.request('GET',f'/v2/payments/authorizations/{id}')
    async def capture(self,id,request_id):return await self.request('POST',f'/v2/payments/authorizations/{id}/capture',{'final_capture':True},request_id)
    async def void(self,id,request_id):return await self.request('POST',f'/v2/payments/authorizations/{id}/void',{},request_id)

# Mock is explicitly labelled in UI and does not claim PayPal integration.
class MockGateway:
    orders={}; auths={}
    async def create(self,amount,sku,request_id):
        id='MOCK-ORDER-'+uuid.uuid4().hex[:10].upper()
        self.orders[id]={'id':id,'status':'CREATED','purchase_units':[{'reference_id':sku,'payee':{'merchant_id':MERCHANT},'amount':{'currency_code':'USD','value':amount}}]}
        return {**self.orders[id],'links':[{'rel':'approve','href':ORIGIN+'/?mock_approve='+id}]}
    async def get_order(self,id):
        if id not in self.orders:raise GatewayError(404,'Unknown mock order')
        return self.orders[id]
    async def approve(self,id):
        data=await self.get_order(id);data['status']='APPROVED';return data
    async def authorize(self,id,request_id):
        order=await self.get_order(id)
        if order['status']!='APPROVED':raise GatewayError(422,'Buyer must approve the order first')
        aid='MOCK-AUTH-'+uuid.uuid4().hex[:10].upper()
        a={'id':aid,'status':'CREATED','amount':order['purchase_units'][0]['amount']}
        self.auths[aid]=a;order['status']='COMPLETED';return {'id':id,'purchase_units':[{'payments':{'authorizations':[a]}}]}
    async def get_authorization(self,id):
        if id not in self.auths:raise GatewayError(404,'Unknown mock authorization')
        return self.auths[id].copy()
    async def capture(self,id,request_id):
        a=self.auths[id]
        if a['status']!='CREATED':raise GatewayError(422,{'name':'UNPROCESSABLE_ENTITY','message':'Authorization not capturable'})
        a['status']='CAPTURED';return {'id':'MOCK-CAP-'+uuid.uuid4().hex[:8].upper(),'status':'COMPLETED','amount':a['amount']}
    async def void(self,id,request_id):
        a=self.auths[id]
        if a['status']!='CREATED':raise GatewayError(422,{'name':'UNPROCESSABLE_ENTITY','message':'Authorization cannot be voided'})
        a['status']='VOIDED';return {'id':id,'status':'VOIDED'}

gateway=SandboxGateway() if MODE=='sandbox' else MockGateway()
