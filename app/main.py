import json,uuid,decimal,datetime,os,asyncio,base64
from pathlib import Path
from urllib.parse import urlparse
from fastapi import FastAPI,HTTPException,Header,UploadFile,File
from fastapi.responses import FileResponse,JSONResponse
import httpx
from pydantic import BaseModel,Field
from .config import MODE,MERCHANT,ADMIN_TOKEN,ORIGIN
from . import store,crypto,ai
from .paypal import gateway,GatewayError

app=FastAPI(title='Payee Pinning · Creator Consent Commerce',version='0.2.0')

@app.on_event('startup')
def boot():
    if MODE=='sandbox' and os.getenv('RENDER') and (urlparse(ORIGIN).hostname or '').lower() in ('localhost','127.0.0.1',''):
        raise RuntimeError('Hosted Sandbox requires APP_ORIGIN to be its public HTTPS URL, not localhost')
    if MODE=='sandbox' and os.getenv('RENDER') and urlparse(ORIGIN).scheme!='https':
        raise RuntimeError('Hosted Sandbox requires an HTTPS APP_ORIGIN')
    store.init()
    # Async worker added at startup, not during import; judge flows settle without an operator.
    if not hasattr(app.state,'timeout_tasks'):app.state.timeout_tasks={}
    loop=asyncio.get_running_loop()
    app.state.timeout_tasks[loop]=loop.create_task(judge_timeout_worker())

@app.on_event('shutdown')
async def stop_worker():
    task=getattr(app.state,'timeout_tasks',{}).pop(asyncio.get_running_loop(),None)
    if task:
        task.cancel()
        try:await task
        except asyncio.CancelledError:pass

def public_judge_enabled():
    return MODE=='sandbox' and os.getenv('PUBLIC_SANDBOX_JUDGE_MODE','0')=='1' and os.getenv('SANDBOX_PUBLIC_ALLOWED')=='I_ACKNOWLEDGE_DISPOSABLE'

def daily_quota(kind,limit):
    # Global, durable daily cap. Each operation checks a current SQLite event count.
    today=datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    with store.tx() as c:
        count=c.execute('SELECT COUNT(*) FROM event WHERE kind=? AND created_at>=?',(kind,today)).fetchone()[0]
        if count>=limit:fail('Public Sandbox judge quota exhausted; reset the isolated test environment tomorrow',429)
        store.event(c,kind,{'daily_count':count+1,'mode':MODE})

def require_admin(token):
    if MODE=='mock' and os.getenv('PUBLIC_MOCK_JUDGE_MODE','0')=='1':return
    if public_judge_enabled():return
    if not token or token!=ADMIN_TOKEN:raise HTTPException(401,'Demo administrator token required (X-Demo-Token)')

def fail(msg,status=400):raise HTTPException(status,msg)

def checked_amount(value):
    try:
        d=decimal.Decimal(str(value)).quantize(decimal.Decimal('0.01'))
        if d<=0 or d>decimal.Decimal('10000'):raise ValueError()
        return f'{d:.2f}'
    except (ValueError,decimal.InvalidOperation):fail('Invalid amount')

def get(table,id):
    with store.tx() as c:obj=store.row(c,table,id)
    if not obj:fail(f'{table} not found',404)
    return obj

def verified_policy(id):
    p=get('policy',id);creator=get('creator',p['creator_id']);payload=json.loads(p['payload'])
    if p['status']=='AWAITING_SIGNATURE' or not crypto.verify(creator['public_key'],payload,p['signature']):fail('Creator policy signature unavailable or invalid',409)
    return p,payload

def policy_check(p,payload,offer,for_existing=False):
    now=datetime.datetime.now(datetime.timezone.utc)
    ends=datetime.datetime.fromisoformat(payload['expires_at'].replace('Z','+00:00'))
    if now>ends:return 'Policy expired'
    if p['status']=='TERMINATED' and not for_existing:return 'Creator commercial termination (future orders blocked)'
    if offer['payee']!=payload['payee_id']:return 'Payee differs from signed creator pin'
    if offer['domain'].lower()!=payload['domain'].lower():return 'Checkout domain differs from signed creator pin'
    if offer['sku']!=payload['sku']:return 'SKU differs from signed creator pin'
    if decimal.Decimal(offer['amount'])>decimal.Decimal(payload['max_price_usd']):return 'Price exceeds signed ceiling'
    return None

def expose_payment(p):
    return {k:p[k] for k in ('id','policy_id','order_id','authorization_id','state','payee','sku','amount','domain','created_at','updated_at','content_id','review_reason') if k in p}

def log_event(kind,details,payment=None,policy=None):
    with store.tx() as c:store.event(c,kind,details,payment,policy)

class NewPolicy(BaseModel):
    creator_label:str='Dana Cole'
    sku:str='CREATOR-DEMO-001'
    domain:str='localhost'
    max_price_usd:str='49.00'
    review_timeout_seconds:int=Field(default=120,ge=15,le=3600)
    duration_minutes:int=Field(default=120,ge=1,le=10080)
    claims:str='Handmade demo item for $49 from my approved merchant.'
    creator_public_key:str|None=None

@app.get('/api/config')
def config():return {'mode':MODE,'merchant_id':MERCHANT,'ai_configured':bool(os.getenv('AI_API_URL') and os.getenv('AI_API_KEY') and os.getenv('AI_MODEL')),'origin':ORIGIN,'judge_mode':(MODE=='mock' and os.getenv('PUBLIC_MOCK_JUDGE_MODE','0')=='1') or public_judge_enabled(),'auto_settle_seconds':int(os.getenv('AUTO_SETTLE_SECONDS','0')),'review_timeout_seconds':int(os.getenv('REVIEW_TIMEOUT_SECONDS','120')),'warning':'MOCK mode: zero PayPal requests' if MODE=='mock' else 'SANDBOX: live PayPal test transactions only'}

@app.post('/api/policies')
def create_policy(data:NewPolicy,x_demo_token:str|None=Header(None)):
    require_admin(x_demo_token)
    if public_judge_enabled():
        daily_quota('PUBLIC_JUDGE_POLICY',int(os.getenv('SANDBOX_DAILY_POLICY_LIMIT','20')))
        if not data.creator_public_key:fail('Public judge enrollment requires browser-held creator key; no server key is issued',403)
    if not MERCHANT:fail('Set PAYPAL_MERCHANT_ID for sandbox mode',503)
    if public_judge_enabled() and decimal.Decimal(checked_amount(data.max_price_usd))>decimal.Decimal(os.getenv('SANDBOX_MAX_AMOUNT','5.00')):
        fail('Public sandbox policy maximum must be at or below $5.00',403)
    cid='creator-'+uuid.uuid4().hex[:10];pid='pin-'+uuid.uuid4().hex[:10]
    private,public=(None,data.creator_public_key) if data.creator_public_key else crypto.generate_key()
    if data.creator_public_key:
        try:
            if len(crypto.unb64(public))!=32:raise ValueError('wrong key length')
        except Exception:fail('Invalid browser creator public key')
    now=datetime.datetime.now(datetime.timezone.utc)
    payload={'id':pid,'creator_id':cid,'creator_label':data.creator_label,'payee_id':MERCHANT,'domain':data.domain,'sku':data.sku,'max_price_usd':checked_amount(data.max_price_usd),'review_timeout_seconds':data.review_timeout_seconds,'claims':data.claims,'issued_at':now.isoformat(),'expires_at':(now+datetime.timedelta(minutes=data.duration_minutes)).isoformat(),'schema_version':1}
    sig=crypto.sign(private,payload) if private else None
    with store.tx() as c:
        c.execute('INSERT INTO creator VALUES(?,?,?)',(cid,public,private or ''))
        c.execute('INSERT INTO policy(id,creator_id,payload,signature,version,status,created_at) VALUES(?,?,?,?,?,?,?)',(pid,cid,json.dumps(payload),sig or '',1,'ACTIVE' if sig else 'AWAITING_SIGNATURE',store.utc()))
        store.event(c,'POLICY_ENROLLED',{'policy_hash':crypto.digest(payload),'public_key':public,'signature_pending':not bool(sig)},policy=pid)
    return {'id':pid,'payload':payload,'signature':sig,'public_key':public,'status':'ACTIVE' if sig else 'AWAITING_SIGNATURE','warning':'Browser-held Ed25519 demo signing, not verified production creator identity' if not sig else 'Legacy server-key demo; do not use for public judge enrollment'}


class ClientSignature(BaseModel):
    signature:str

@app.post('/api/policies/{policy_id}/activate')
def activate_signed_policy(policy_id:str,data:ClientSignature):
    with store.tx() as c:
        policy=store.row(c,'policy',policy_id)
        if not policy:fail('Policy missing',404)
        if policy['status']!='AWAITING_SIGNATURE':fail('Policy already activated or unavailable',409)
        creator=store.row(c,'creator',policy['creator_id'])
        payload=json.loads(policy['payload'])
        if not crypto.verify(creator['public_key'],payload,data.signature):fail('Ed25519 creator signature invalid',409)
        c.execute('UPDATE policy SET signature=?,status=? WHERE id=?',(data.signature,'ACTIVE',policy_id))
        store.event(c,'POLICY_SIGNED',{'policy_hash':crypto.digest(payload),'public_key':creator['public_key'],'key_custody':'browser'},policy=policy_id)
    return {'id':policy_id,'status':'ACTIVE','signature_valid':True}

@app.get('/api/policies')
def policies():
    with store.tx() as c:rows=c.execute('SELECT * FROM policy ORDER BY created_at DESC LIMIT 50').fetchall()
    return [{'id':x['id'],'status':x['status'],'version':x['version'],'payload':json.loads(x['payload']),'signature':x['signature']} for x in rows]

class Checkout(BaseModel):
    policy_id:str
    amount:str
    sku:str
    domain:str='localhost'
    payee:str|None=None  # Adversarial test hint only; never trusted for settlement
    content_id:str|None=None

@app.post('/api/checkouts')
async def checkout(data:Checkout):
    p,payload=verified_policy(data.policy_id)
    if public_judge_enabled():
        if decimal.Decimal(checked_amount(data.amount))>decimal.Decimal(os.getenv('SANDBOX_MAX_AMOUNT','5.00')):
            fail('Public sandbox transactions are capped at $5.00',403)
        daily_quota('PUBLIC_JUDGE_ORDER',int(os.getenv('SANDBOX_DAILY_ORDER_LIMIT','25')))
    # Checkout origin is server-controlled; a client-supplied domain is just a mismatch test.
    actual_domain=(urlparse(ORIGIN).hostname or 'localhost').lower()
    if data.domain.lower()!=actual_domain:
        return JSONResponse({'decision':'BLOCK','phase':'PRE_AUTH','reason':'Client checkout domain differs from actual server origin','paypal_order_created':False},status_code=409)
    # Effective merchant comes from the server's actual PayPal credentials, not the browser.
    # An explicit mismatch is treated as an adversarial claim and refused before an order is made.
    offer={'amount':checked_amount(data.amount),'sku':data.sku,'domain':actual_domain,'payee':MERCHANT}
    if data.payee is not None and data.payee!=MERCHANT:
        log_event('UNTRUSTED_PAYEE_CLAIM',{'claimed':data.payee,'configured_merchant':MERCHANT},policy=p['id'])
        return JSONResponse({'decision':'BLOCK','phase':'PRE_AUTH','reason':'Untrusted client payee differs from configured merchant; no remote payee swap executed','paypal_order_created':False},status_code=409)
    reason=policy_check(p,payload,offer)
    if reason:
        log_event('PRE_AUTH_BLOCK',{'reason':reason,'offer':offer},policy=p['id'])
        return JSONResponse({'decision':'BLOCK','phase':'PRE_AUTH','reason':reason,'paypal_order_created':False},status_code=409)
    # The PayPal request creates an order, NOT an authorization. Buyer must approve it.
    id='txn-'+uuid.uuid4().hex[:12];rid='create-'+id
    result=await gateway.create(offer['amount'],offer['sku'],rid)
    order_id=result['id'];approve=next((x.get('href') for x in result.get('links',[]) if x.get('rel') in ('approve','payer-action')),None)
    with store.tx() as c:
        c.execute('INSERT INTO payment(id,policy_id,order_id,amount,sku,payee,domain,state,policy_version,request_id,api_response,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',(id,p['id'],order_id,offer['amount'],offer['sku'],offer['payee'],offer['domain'],'ORDER_CREATED',p['version'],rid,json.dumps(result),store.utc(),store.utc()))
        if data.content_id:c.execute('UPDATE payment SET content_id=? WHERE id=?',(data.content_id[:128],id))
        store.event(c,'ORDER_CREATED',{'mode':MODE,'order_id':order_id,'response':result},id,p['id'])
    return {'decision':'AWAIT_BUYER','payment_id':id,'order_id':order_id,'approval_url':approve,'mode':MODE}

@app.post('/api/mock-approve/{payment_id}')
async def mock_approve(payment_id:str):
    if MODE!='mock':fail('This endpoint is only available in MOCK mode',403)
    p=get('payment',payment_id)
    await gateway.approve(p['order_id'])
    return {'status':'APPROVED','mode':'mock'}

@app.post('/api/payments/{payment_id}/authorize')
async def authorize(payment_id:str):
    with store.tx() as c:
        p=store.row(c,'payment',payment_id)
        if not p:fail('Payment missing',404)
        if p['state']=='AUTHORIZED':return expose_payment(p)
        if p['state']!='ORDER_CREATED':fail('Payment not awaiting authorization',409)
        c.execute('UPDATE payment SET state=?,updated_at=? WHERE id=?',('AUTHORIZING',store.utc(),payment_id))
    try:
        order=await gateway.get_order(p['order_id'])
        if order['status'] not in ('APPROVED',):raise GatewayError(409,{'message':'Buyer approval required','order_status':order['status']})
        units=order.get('purchase_units',[])
        if len(units)!=1:raise GatewayError(409,{'message':'Exactly one purchase unit required'})
        unit=units[0]
        if unit.get('reference_id')!=p['sku'] or unit.get('amount',{}).get('value')!=p['amount']:
            raise GatewayError(409,{'message':'Approved PayPal order changed SKU or amount'})
        observed_payee=unit.get('payee',{}).get('merchant_id')
        if not observed_payee:
            raise GatewayError(409,{'message':'PayPal payee ID is missing in approved order; cannot verify creator pin'})
        if observed_payee!=p['payee']:
            raise GatewayError(409,{'message':'Approved PayPal payee differs from creator pin'})
        result=await gateway.authorize(p['order_id'],'authorize-'+payment_id)
        units=result.get('purchase_units',[])
        auths=[a for u in units for a in u.get('payments',{}).get('authorizations',[])]
        if len(auths)!=1:raise GatewayError(502,{'message':'Expected exactly one PayPal authorization','response':result})
        aid=auths[0]['id']
        with store.tx() as c:
            fresh = store.row(c, 'payment', payment_id)
            verdict = c.execute('SELECT * FROM content_verdict WHERE policy_id=? AND content_id=?',
                        (p['policy_id'], fresh['content_id'])).fetchone() if fresh['content_id'] else None
            held = bool(verdict and verdict['status'] == 'MISMATCH')
            state = 'HELD_FOR_REVIEW' if held else 'AUTHORIZED'
            c.execute('UPDATE payment SET authorization_id=?,state=?,api_response=?,review_reason=?,review_evidence=?,review_since=?,updated_at=? WHERE id=?',
                      (aid, state, json.dumps(result), 'AI_CLAIM_MISMATCH' if held else None,
                       verdict['evidence'] if held else None, store.utc() if held else None,
                       store.utc(), payment_id))
            store.event(c, 'AUTHORIZED' if not held else 'AUTHORIZED_HELD_FROM_CONTENT_VERDICT',
                        {'authorization_id': aid, 'response': result,
                         'content_id': fresh['content_id'], 'held': held}, payment_id, p['policy_id'])
        return {'payment_id':payment_id,'authorization_id':aid,'state':state,'paypal_response':result}
    except Exception as exc:
        with store.tx() as c:
            c.execute('UPDATE payment SET state=?,updated_at=? WHERE id=?',('RECONCILE_REQUIRED' if isinstance(exc,GatewayError) and exc.code>=500 else 'ORDER_CREATED',store.utc(),payment_id))
            store.event(c,'AUTHORIZE_FAILED',{'error':str(exc)},payment_id,p['policy_id'])
        raise

class Revoke(BaseModel):
    revocation_class:str
    reason:str
    evidence:str=''
    creator_signature:str|None=None
    creator_time:str|None=None

@app.post('/api/policies/{policy_id}/revoke')
async def revoke(policy_id:str,data:Revoke,x_demo_token:str|None=Header(None)):
    require_admin(x_demo_token)
    if data.revocation_class not in ('fraud','commercial'):fail('Use fraud or commercial')
    if not data.reason.strip():fail('Reason required')
    p,payload=verified_policy(policy_id)
    creator=get('creator',p['creator_id'])
    rec={'policy_id':policy_id,'kind':data.revocation_class,'reason':data.reason,'evidence':data.evidence,'time':data.creator_time or store.utc()}
    if creator['private_key']:
        signature=crypto.sign(creator['private_key'],rec)
    else:
        signature=data.creator_signature
        if not signature or not crypto.verify(creator['public_key'],rec,signature):fail('Valid browser creator signature required',403)
    # Broad fraud revocation is REVIEW-ONLY: a creator cannot globally void unrelated buyer orders
    # merely by submitting an arbitrary text string. Per-order signed review is the demo control.
    effective=(data.revocation_class=='commercial')
    with store.tx() as c:
        current=store.row(c,'policy',policy_id)
        if current['status']!='ACTIVE':fail('Policy no longer active',409)
        if effective:
            c.execute('UPDATE policy SET status=?,version=version+1 WHERE id=?',('TERMINATED',policy_id))
        store.event(c,'REVOCATION_'+('EFFECTIVE' if effective else 'REVIEW_REQUIRED'),{'record':rec,'signature':signature,'warning':'Evidence presence alone is not independent proof of fraud; demo policy requires review in production'},policy=policy_id)
    # Review-only broad fraud reports never sweep all pending payments.
    actions=[]
    return {'effective':effective,'status':'TERMINATED' if effective else 'REVIEW_REQUIRED','signature':signature,'record':rec,'payment_actions':actions,'warning':'In-flight capture cannot be guaranteed voidable'}

@app.post('/api/mock/lab/{payment_id}/flag-review')
async def mock_lab_flag(payment_id:str,x_demo_token:str|None=Header(None)):
    require_admin(x_demo_token)
    if MODE!='mock':fail('Synthetic test flag is strictly MOCK only; configure LIVE_LLM for Sandbox review',403)
    with store.tx() as c:
        pay=store.row(c,'payment',payment_id)
        if not pay or pay['state']!='AUTHORIZED':fail('Must be a locally authorized mock order',409)
        c.execute("UPDATE payment SET state='HELD_FOR_REVIEW',review_reason=?,review_evidence=?,review_since=?,updated_at=? WHERE id=?",('SYNTHETIC_MOCK_TEST',json.dumps({'test_only':True,'warning':'No AI inference performed'}),store.utc(),store.utc(),payment_id))
        store.event(c,'MOCK_SYNTHETIC_REVIEW_HOLD',{'test_only':True,'ai_used':False},payment_id,pay['policy_id'])
    return {'state':'HELD_FOR_REVIEW','mode':'MOCK','ai_used':False,'synthetic_test_only':True}

class ReviewFlag(BaseModel):
    content_id:str
    transcript:str
    claim_evidence:dict|None=None

def _persist_content_verdict(policy_id, content_id, reference, extraction, comparison):
    """Persist one verified model result and place every authorized attributed order on hold."""
    mismatch = comparison['status'] == 'MISMATCH'
    evidence = {'reference_extraction': reference, 'observed_extraction': extraction,
                'comparison': comparison, 'content_id': content_id}
    affected = []
    with store.tx() as c:
        c.execute('INSERT INTO content_verdict(policy_id,content_id,status,evidence,model,analyzed_at) '
                  'VALUES(?,?,?,?,?,?) ON CONFLICT(policy_id,content_id) DO UPDATE SET '
                  'status=excluded.status,evidence=excluded.evidence,model=excluded.model,analyzed_at=excluded.analyzed_at',
                  (policy_id, content_id, comparison['status'], json.dumps(evidence),
                   extraction.get('model'), store.utc()))
        if mismatch:
            payments = c.execute("SELECT id FROM payment WHERE policy_id=? AND content_id=? AND state='AUTHORIZED'",
                                 (policy_id, content_id)).fetchall()
            for payment in payments:
                payment_id = payment['id']
                c.execute("UPDATE payment SET state='HELD_FOR_REVIEW',review_reason=?,review_evidence=?,review_since=?,updated_at=? WHERE id=? AND state='AUTHORIZED'",
                          ('AI_CLAIM_MISMATCH', json.dumps(evidence), store.utc(), store.utc(), payment_id))
                store.event(c, 'AI_REVIEW_HOLD', {'comparison': comparison, 'content_id': content_id,
                            'model': extraction.get('model')}, payment_id, policy_id)
                affected.append(payment_id)
        store.event(c, 'CONTENT_AI_VERDICT', {'content_id': content_id, 'status': comparison['status'],
                     'affected': affected, 'model': extraction.get('model')}, policy=policy_id)
    return affected


class ContentAnalysis(BaseModel):
    policy_id: str
    content_id: str = Field(min_length=1, max_length=128)
    transcript: str = Field(min_length=1, max_length=12000)


@app.post('/api/content/analyze')
async def analyze_content(data: ContentAnalysis, x_demo_token: str | None = Header(None)):
    """Analyze once per content ID; subsequent authorizations inherit the verdict."""
    require_admin(x_demo_token)
    if public_judge_enabled():
        daily_quota('PUBLIC_JUDGE_AI', int(os.getenv('SANDBOX_DAILY_AI_LIMIT', '30')))
    policy, payload = verified_policy(data.policy_id)
    with store.tx() as c:
        earlier = c.execute('SELECT status,evidence,model FROM content_verdict WHERE policy_id=? AND content_id=?',
                            (data.policy_id, data.content_id)).fetchone()
    if earlier:
        existing = json.loads(earlier['evidence'])
        return {'held': earlier['status'] == 'MISMATCH', 'affected_payment_ids': [],
                'content_id': data.content_id, 'content_verdict': earlier['status'],
                'comparison': existing['comparison'], 'cached': True,
                'warning': 'First verified analysis is retained for this content ID; a new upload must have a new identifier'}
    try:
        reference = await ai.extract_claims(payload['claims'])
        extraction = await ai.extract_claims(data.transcript)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 429:
            # Preserve the payment as authorized/unreviewed. Never fabricate an AI verdict.
            warning = 'Gemini quota or rate limit reached (HTTP 429). Check AI Studio usage and retry after quota permits.'
            return {'held': False, 'reason': 'AI_UNAVAILABLE', 'warning': warning,
                    'reference': {'mode': 'UNAVAILABLE', 'reason': warning},
                    'analysis': {'mode': 'UNAVAILABLE', 'reason': warning},
                    'content_id': data.content_id}
        raise HTTPException(502, 'Model analysis failed: upstream HTTP ' + str(exc.response.status_code))
    except Exception as exc:
        raise HTTPException(502, 'Model analysis failed: ' + str(exc))
    if reference.get('mode') != 'LIVE_LLM' or extraction.get('mode') != 'LIVE_LLM':
        return {'held': False, 'reason': 'AI_UNAVAILABLE', 'reference': reference,
                'analysis': extraction, 'content_id': data.content_id}
    comparison = ai.compare_endorsements(reference.get('claims'), extraction.get('claims'))
    affected = _persist_content_verdict(policy['id'], data.content_id, reference, extraction, comparison)
    return {'held': bool(affected), 'affected_payment_ids': affected, 'comparison': comparison,
            'reference': reference, 'analysis': extraction, 'content_id': data.content_id,
            'content_verdict': comparison['status']}


@app.post('/api/payments/{payment_id}/analyze-review')
async def analyze_order_review(payment_id: str, data: ReviewFlag, x_demo_token: str | None = Header(None)):
    pay = get('payment', payment_id)
    if pay['state'] != 'AUTHORIZED':
        fail('Only authorized payments can enter review', 409)
    if not pay['content_id'] or pay['content_id'] != data.content_id:
        fail('Attribution does not match original order', 409)
    result = await analyze_content(ContentAnalysis(policy_id=pay['policy_id'],
                    content_id=data.content_id, transcript=data.transcript), x_demo_token)
    return {**result, 'state': 'HELD_FOR_REVIEW' if payment_id in result.get('affected_payment_ids', [])
            else 'AUTHORIZED'}

class ReviewDecision(BaseModel):
    action:str
    reason:str
    creator_time:str
    creator_signature:str

@app.post('/api/payments/{payment_id}/creator-review')
async def creator_review(payment_id:str,data:ReviewDecision,x_demo_token:str|None=Header(None)):
    require_admin(x_demo_token)
    if data.action not in ('APPROVE','VOID'):fail('Review action must be APPROVE or VOID')
    if not data.reason.strip():fail('Reason required')
    with store.tx() as c:
        pay=store.row(c,'payment',payment_id)
        if not pay:fail('Payment not found',404)
        if pay['state']!='HELD_FOR_REVIEW':fail('Order is not held for review',409)
        pol=store.row(c,'policy',pay['policy_id']);creator=store.row(c,'creator',pol['creator_id'])
        record={'payment_id':payment_id,'policy_id':pol['id'],'action':data.action,'reason':data.reason,'time':data.creator_time}
        if not crypto.verify(creator['public_key'],record,data.creator_signature):fail('Invalid creator review signature',403)
        desired='AUTHORIZED' if data.action=='APPROVE' else 'VOID_PENDING'
        c.execute('UPDATE payment SET state=?,request_id=?,updated_at=? WHERE id=?',(desired,('void-'+payment_id if data.action=='VOID' else 'creator-approved-'+payment_id),store.utc(),payment_id))
        store.event(c,'CREATOR_REVIEW_SIGNED',{'record':record,'signature':data.creator_signature},payment_id,pay['policy_id'])
    if data.action=='APPROVE':return await settle(payment_id,ADMIN_TOKEN)
    return await _void_reserved(pay,'CREATOR_REVIEW_VOID')

async def _void_reserved(pay,reason):
    # State was reserved transactionally by the reviewing actor or timeout worker.
    payment_id=pay['id']
    try:
        before=await gateway.get_authorization(pay['authorization_id'])
        if before.get('status') not in ('CREATED','AUTHORIZED'):
            raise GatewayError(409,{'message':'Authorization not voidable','readback':before})
        result=await gateway.void(pay['authorization_id'],'void-'+payment_id)
        after=await gateway.get_authorization(pay['authorization_id'])
        state='VOIDED' if after.get('status')=='VOIDED' else 'RECONCILE_REQUIRED'
        with store.tx() as c:
            c.execute('UPDATE payment SET state=?,api_response=?,updated_at=? WHERE id=?',(state,json.dumps({'operation':result,'readback':after}),store.utc(),payment_id))
            store.event(c,'PAYPAL_READBACK',{'action':'VOID','reason':reason,'operation':result,'readback':after},payment_id,pay['policy_id'])
        return {'payment_id':payment_id,'mode':MODE,'action':'VOID','state':state,'reason':reason,'paypal_operation':result,'paypal_readback':after}
    except Exception as exc:
        with store.tx() as c:
            c.execute("UPDATE payment SET state='RECONCILE_REQUIRED',updated_at=? WHERE id=?",(store.utc(),payment_id))
            store.event(c,'REVIEW_VOID_UNCERTAIN',{'error':str(exc)},payment_id,pay['policy_id'])
        raise

async def resolve_review_timeout(payment_id):
    with store.tx() as c:
        pay=store.row(c,'payment',payment_id)
        if not pay or pay['state']!='HELD_FOR_REVIEW':return {'skipped':True}
        policy = store.row(c, 'policy', pay['policy_id'])
        payload = json.loads(policy['payload'])
        creator = store.row(c, 'creator', policy['creator_id'])
        if not crypto.verify(creator['public_key'], payload, policy['signature']):
            fail('Creator policy signature invalid; cannot auto-void', 409)
        deadline_seconds = int(payload.get('review_timeout_seconds', 120))
        started = datetime.datetime.fromisoformat(pay['review_since'].replace('Z', '+00:00'))
        if (datetime.datetime.now(datetime.timezone.utc) - started).total_seconds() < deadline_seconds:
            return {'skipped': True, 'reason': 'Signed creator review window has not elapsed'}
        c.execute("UPDATE payment SET state='VOID_PENDING',request_id=?,updated_at=? WHERE id=?",('void-'+payment_id,store.utc(),payment_id))
        store.event(c,'REVIEW_TIMEOUT_VOID',{'reason':'Creator did not respond before review timeout'},payment_id,pay['policy_id'])
    return await _void_reserved(pay,'REVIEW_TIMEOUT')

@app.post('/api/lab/{payment_id}/capture-after-void')
async def capture_after_void(payment_id:str,x_demo_token:str|None=Header(None)):
    require_admin(x_demo_token)
    if public_judge_enabled():daily_quota('PUBLIC_JUDGE_PROBE',int(os.getenv('SANDBOX_DAILY_PROBE_LIMIT','10')))
    pay=get('payment',payment_id)
    if pay['state']!='VOIDED':fail('Lab experiment only allowed for confirmed VOIDED authorization',409)
    try:
        result=await gateway.capture(pay['authorization_id'],'proof-capture-after-void-'+payment_id)
        outcome={'unexpected_success':True,'response':result,'mode':MODE}
    except GatewayError as exc:
        outcome={'expected_refusal':True,'http_status':exc.code,'raw_gateway_response':exc.details,'mode':MODE}
    after=await gateway.get_authorization(pay['authorization_id'])
    outcome['authorization_readback']=after
    log_event('CAPTURE_AFTER_VOID_PROBE',outcome,payment_id,pay['policy_id'])
    return outcome

@app.post('/api/payments/{payment_id}/settle')
async def settle(payment_id:str,x_demo_token:str|None=Header(None)):
    require_admin(x_demo_token)
    # Own-service serialization: only one caller can claim AUTHORIZED -> *_PENDING.
    # Remote API is not atomic with SQLite: unresolved network outcomes MUST reconcile.
    with store.tx() as c:
        pay=store.row(c,'payment',payment_id)
        if not pay:fail('Payment missing',404)
        if pay['state'] in ('CAPTURED','VOIDED'):return {'state':pay['state'],'idempotent':True}
        if pay['state']=='HELD_FOR_REVIEW':fail('Order held for creator review; no capture allowed',409)
        if pay['state']!='AUTHORIZED':fail('Payment not in AUTHORIZED state',409)
        policy=store.row(c,'policy',pay['policy_id'])
        if not policy:fail('Policy missing',409)
        payload=json.loads(policy['payload'])
        creator=store.row(c,'creator',policy['creator_id'])
        valid_signature=crypto.verify(creator['public_key'],payload,policy['signature'])
        reason='Invalid policy signature' if not valid_signature else policy_check(policy,payload,pay,for_existing=True)
        action='VOID' if reason else 'CAPTURE'
        request_id=action.lower()+'-'+payment_id
        c.execute('UPDATE payment SET state=?,request_id=?,updated_at=? WHERE id=?',(action+'_PENDING',request_id,store.utc(),payment_id))
        store.event(c,'DECISION_LOCKED',{'action':action,'reason':reason,'policy_version':policy['version']},payment_id,pay['policy_id'])
    try:
        before=await gateway.get_authorization(pay['authorization_id'])
        if before.get('status') not in ('CREATED','AUTHORIZED'):
            raise GatewayError(409,{'message':'Authorization is not capturable/voidable','readback':before})
        # This is the externally observed amount; policy cannot rely only on the local row.
        observed=before.get('amount',{}).get('value')
        if observed and checked_amount(observed)!=pay['amount']:
            reason='PayPal authorization amount drift';action='VOID'
            with store.tx() as c:
                c.execute('UPDATE payment SET state=?,request_id=? WHERE id=?',('VOID_PENDING','void-'+payment_id,payment_id))
                store.event(c,'AUTH_AMOUNT_MISMATCH',{'observed':observed},payment_id,pay['policy_id'])
        # Read order's original SKU, which auth-detail endpoint does not provide.
        order=await gateway.get_order(pay['order_id'])
        units=order.get('purchase_units',[])
        if len(units)!=1 or units[0].get('reference_id')!=pay['sku']:
            reason='PayPal order SKU drift';action='VOID'
        if len(units)==1:
            actual_amount=units[0].get('amount',{}).get('value')
            if actual_amount and checked_amount(actual_amount)!=pay['amount']:
                reason='PayPal order amount drift';action='VOID'
            actual_payee=units[0].get('payee',{}).get('merchant_id')
            if not actual_payee or actual_payee!=pay['payee']:
                reason='PayPal order payee missing or changed';action='VOID'
        if action=='VOID':
            with store.tx() as c:
                c.execute('UPDATE payment SET state=?,request_id=?,updated_at=? WHERE id=?',('VOID_PENDING','void-'+payment_id,store.utc(),payment_id))
                store.event(c,'VOID_DECISION_CONFIRMED',{'reason':reason},payment_id,pay['policy_id'])
        if action=='CAPTURE':result=await gateway.capture(pay['authorization_id'],'capture-'+payment_id)
        else:result=await gateway.void(pay['authorization_id'],'void-'+payment_id)
        after=await gateway.get_authorization(pay['authorization_id'])
        status=after.get('status')
        expected=('CAPTURED','PARTIALLY_CAPTURED') if action=='CAPTURE' else ('VOIDED',)
        state= 'CAPTURED' if action=='CAPTURE' and (status in expected or result.get('status')=='COMPLETED') else 'VOIDED' if action=='VOID' and status=='VOIDED' else 'RECONCILE_REQUIRED'
        with store.tx() as c:
            c.execute('UPDATE payment SET state=?,api_response=?,updated_at=? WHERE id=?',(state,json.dumps({'operation':result,'readback':after,'order':order}),store.utc(),payment_id))
            store.event(c,'PAYPAL_READBACK',{'action':action,'reason':reason,'operation':result,'readback':after},payment_id,pay['policy_id'])
        return {'payment_id':payment_id,'mode':MODE,'action':action,'state':state,'reason':reason,'paypal_operation':result,'paypal_readback':after}
    except Exception as exc:
        with store.tx() as c:
            c.execute('UPDATE payment SET state=?,updated_at=? WHERE id=?',('RECONCILE_REQUIRED',store.utc(),payment_id))
            store.event(c,'SETTLEMENT_UNCERTAIN',{'error':str(exc),'warning':'Do not blindly retry payment modification; reconcile with PayPal first'},payment_id,pay['policy_id'])
        raise

@app.get('/api/payments')
def payments():
    with store.tx() as c:rows=c.execute('SELECT * FROM payment ORDER BY created_at DESC LIMIT 150').fetchall()
    return [expose_payment(dict(x)) for x in rows]

@app.get('/api/payments/{payment_id}')
async def payment_detail(payment_id:str):
    p=get('payment',payment_id)
    observed=None
    if p['authorization_id']:
        try:observed=await gateway.get_authorization(p['authorization_id'])
        except GatewayError as e:observed={'readback_error':e.details}
    return {'payment':expose_payment(p),'paypal_readback':observed,'stored_api_response':json.loads(p['api_response']) if p['api_response'] else None}

@app.post('/api/payments/{payment_id}/reconcile')
async def reconcile(payment_id:str,x_demo_token:str|None=Header(None)):
    require_admin(x_demo_token);p=get('payment',payment_id)
    if not p['authorization_id']:fail('No recorded authorization to reconcile',409)
    a=await gateway.get_authorization(p['authorization_id'])
    new={'VOIDED':'VOIDED','CAPTURED':'CAPTURED','PARTIALLY_CAPTURED':'RECONCILE_REQUIRED','CREATED':'AUTHORIZED'}.get(a.get('status'),'RECONCILE_REQUIRED')
    with store.tx() as c:
        c.execute('UPDATE payment SET state=?,updated_at=? WHERE id=?',(new,store.utc(),payment_id))
        store.event(c,'RECONCILED',{'paypal_readback':a,'new_state':new},payment_id,p['policy_id'])
    return {'state':new,'paypal_readback':a}

@app.get('/api/events')
def events():
    with store.tx() as c:rows=c.execute('SELECT * FROM event ORDER BY id DESC LIMIT 200').fetchall()
    return [{**dict(x),'details':json.loads(x['details'])} for x in rows]

class ClaimInput(BaseModel):
    transcript:str
    policy_id:str|None=None
    checkout_sku:str|None=None
    checkout_amount:str|None=None
    checkout_merchant_name:str=''

@app.post('/api/evidence/claims')
async def claims(data:ClaimInput):
    if public_judge_enabled():daily_quota('PUBLIC_JUDGE_AI',int(os.getenv('SANDBOX_DAILY_AI_LIMIT','30')))
    try:extracted=await ai.extract_claims(data.transcript)
    except Exception as e:raise HTTPException(502,'AI endpoint failed: '+str(e))
    if data.policy_id:
        p,payload=verified_policy(data.policy_id)
        evidence={'policy_id':p['id'],'policy_signature_valid':True,'creator_signed_claim':payload['claims'],'signed_sku':payload['sku'],'signed_ceiling':payload['max_price_usd'],'payee_id':payload['payee_id'],'policy_status':p['status']}
    else:evidence={'policy_id':None,'warning':'No signed policy means no proof that endorsement is unauthorized'}
    comparison=ai.compare_offer(extracted.get('claims'),{'sku':data.checkout_sku or '', 'amount':data.checkout_amount or '0','merchant_name':data.checkout_merchant_name}) if extracted.get('claims') else {'status':'UNKNOWN'}
    return {'evidence':evidence,'ai':extracted,'claim_vs_offer':comparison,'disclaimer':'Evidence for human review, not an automatic PayPal dispute or refund decision'}

@app.post('/api/evidence/video-fingerprint')
async def fingerprint(file:UploadFile=File(...)):
    data=await file.read(20*1024*1024+1)
    if len(data)>20*1024*1024:fail('20MB upload limit',413)
    try:return {'sha256':__import__('hashlib').sha256(data).hexdigest(),'frames':ai.video_fingerprints(data),'method':'Perceptual hashing (not AI)'}
    except ValueError as e:fail(str(e),422)

@app.post('/api/evidence/compare-videos')
async def compare_videos(original:UploadFile=File(...),suspected:UploadFile=File(...),x_demo_token:str|None=Header(None)):
    require_admin(x_demo_token)
    if public_judge_enabled():daily_quota('PUBLIC_JUDGE_VIDEO',int(os.getenv('SANDBOX_DAILY_VIDEO_LIMIT','5')))
    a=await original.read(20*1024*1024+1)
    b=await suspected.read(20*1024*1024+1)
    if len(a)>20*1024*1024 or len(b)>20*1024*1024:fail('Each video must be <=20MB',413)
    try:
        result=await asyncio.to_thread(ai.compare_videos,a,b)
        result['interpretation']='Possible similarity evidence; not identity proof or authority to block money.'
        return result
    except ValueError as exc:fail(str(exc),422)


async def judge_timeout_worker():
    # Captures are manual by default; unanswered AI-held orders void on a separate timer.
    capture_delay=int(os.getenv('AUTO_SETTLE_SECONDS','0'))
    while True:
        await asyncio.sleep(5)
        try:
            now=datetime.datetime.now(datetime.timezone.utc)
            with store.tx() as c:
                held=c.execute("SELECT id FROM payment WHERE state='HELD_FOR_REVIEW' ORDER BY review_since LIMIT 30").fetchall()
                authorized=[]
                if capture_delay>=5:
                    capture_cutoff=(now-datetime.timedelta(seconds=capture_delay)).isoformat()
                    authorized=c.execute("SELECT id FROM payment WHERE state='AUTHORIZED' AND updated_at<=? ORDER BY updated_at LIMIT 10",(capture_cutoff,)).fetchall()
            for row in held:
                try:await resolve_review_timeout(row['id'])
                except Exception as e:log_event('AUTO_VOID_ERROR',{'message':str(e)},payment=row['id'])
            for row in authorized:
                try:await settle(row['id'],ADMIN_TOKEN)
                except HTTPException as e:
                    if e.status_code!=409:log_event('AUTO_SETTLE_ERROR',{'message':str(e)},payment=row['id'])
                except Exception as e:log_event('AUTO_SETTLE_ERROR',{'message':str(e)},payment=row['id'])
        except asyncio.CancelledError:raise
        except Exception as exc:log_event('WORKER_ERROR',{'message':str(exc)})

@app.get('/api/health')
def health():return {'status':'ok','mode':MODE}

@app.get('/')
def index():return FileResponse(Path(__file__).parent.parent/'static'/'index.html')
@app.get('/static/app.js')
def js():return FileResponse(Path(__file__).parent.parent/'static'/'app.js',media_type='application/javascript')
@app.get('/static/style.css')
def css():return FileResponse(Path(__file__).parent.parent/'static'/'style.css',media_type='text/css')

@app.exception_handler(GatewayError)
async def on_gateway_error(request,exc):
    return JSONResponse(status_code=exc.code if 400<=exc.code<=599 else 502,content={'error':'Payment gateway error','details':exc.details,'mode':MODE})
