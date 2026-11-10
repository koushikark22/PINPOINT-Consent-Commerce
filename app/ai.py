"""Optional REAL model integrations. A rule-based comparison is never represented as AI.
AI text analysis requires AI_API_URL, AI_API_KEY and AI_MODEL. Image embedding requires
ENABLE_LOCAL_AI=1 and installation of requirements-ai.txt. Failure reports UNAVAILABLE.
"""
import os,re,json,io,hashlib,subprocess,tempfile
from pathlib import Path
import httpx
from PIL import Image,ImageOps
import numpy as np

def ahash(im):
    im=im.convert('L').resize((8,8))
    a=np.asarray(im,dtype=float)
    bits=a>a.mean()
    return ''.join('1' if x else '0' for x in bits.ravel())
def phash(im):
    """64-bit low-frequency DCT perceptual hash; unlike aHash, uses frequency coefficients."""
    a=np.asarray(im.convert('L').resize((32,32)),dtype=np.float64)
    n=32
    angles=(np.arange(n)[:,None]*2+1)*(np.arange(n)[None,:]*np.pi/(2*n))
    cosine=np.cos(angles).T
    cosine[0,:]*=1/np.sqrt(2)
    coeff=cosine @ a @ cosine.T
    low=coeff[:8,:8].copy()
    median=np.median(low.ravel()[1:])
    return ''.join('1' if v>median else '0' for v in low.ravel())

def hd(a,b):return sum(x!=y for x,y in zip(a,b))
def frames(video_bytes):
    with tempfile.TemporaryDirectory() as d:
        f=Path(d)/'clip.mp4';f.write_bytes(video_bytes)
        cmd=['ffmpeg','-hide_banner','-loglevel','error','-i',str(f),'-vf','fps=1,scale=320:-1','-frames:v','12',str(Path(d)/'%03d.jpg')]
        try:subprocess.run(cmd,capture_output=True,timeout=35,check=True)
        except (FileNotFoundError,subprocess.CalledProcessError,subprocess.TimeoutExpired) as e:raise ValueError('ffmpeg must be installed and video decodable') from e
        return [Image.open(p).convert('RGB').copy() for p in sorted(Path(d).glob('*.jpg'))]
def video_fingerprints(buf):
    out=[]
    for f in frames(buf):out.append({'hash':phash(f),'mirror_hash':phash(ImageOps.mirror(f))})
    if not out:raise ValueError('No video frames extracted')
    return out

def compare_frames(a,b):
    if not a or not b:return {'available':False}
    best=min(min(hd(x['hash'],y['hash']),hd(x['mirror_hash'],y['hash'])) for x in a for y in b)
    return {'available':True,'algorithm':'64-bit DCT pHash + mirror (perceptual, NOT AI)','minimum_hamming':best,'potential_copy':best<=12,'warning':'Heuristic only; cropping may evade detection'}

async def extract_claims(transcript):
    url=os.getenv('AI_API_URL','').strip();key=os.getenv('AI_API_KEY','').strip();model=os.getenv('AI_MODEL','').strip()
    if not (url and key and model):return {'mode':'UNAVAILABLE','reason':'Configure AI_API_URL, AI_API_KEY and AI_MODEL; no AI claim is made','claims':None}
    instructions='Extract a creator product endorsement from user-supplied transcript. Respond ONLY JSON: {"product":string|null,"sku":string|null,"price_usd":number|null,"merchant":string|null,"claims":string[],"disclaimers":string[]}. Do not invent absent facts.'
    async with httpx.AsyncClient(timeout=50) as c:
        r=await c.post(url,headers={'Authorization':'Bearer '+key},json={'model':model,'temperature':0,'response_format':{'type':'json_object'},'messages':[{'role':'system','content':instructions},{'role':'user','content':transcript}]})
    r.raise_for_status()
    content=r.json()['choices'][0]['message']['content']
    content=content.strip().removeprefix('```json').removeprefix('```').removesuffix('```').strip()
    return {'mode':'LIVE_LLM','model':model,'claims':json.loads(content)}

def compare_offer(claims,offer):
    """Deterministic transparent evaluation of confirmed claims against transaction data."""
    if not claims:return {'status':'UNKNOWN','reasons':['No creator-confirmed extracted claims']}
    reasons=[]
    if claims.get('sku') and claims['sku']!=offer['sku']:reasons.append('SKU differs from extracted claim')
    if claims.get('price_usd') is not None and int(round(float(claims['price_usd'])*100)) < int(round(float(offer['amount'])*100)):reasons.append('Checkout price exceeds stated price')
    if claims.get('merchant') and claims['merchant'].lower()!=offer.get('merchant_name','').lower():reasons.append('Merchant name differs from extracted claim; manual confirmation required')
    return {'status':'MISMATCH' if reasons else 'CONSISTENT','reasons':reasons}

def compare_endorsements(signed_claims,candidate_claims):
    """Review-only difference between creator-signed narrative and observed ad, not a payment authority."""
    if not signed_claims or not candidate_claims:
        return {'status':'UNKNOWN','reasons':['Insufficient model extraction for comparison']}
    reasons=[]
    signed_price=signed_claims.get('price_usd')
    ad_price=candidate_claims.get('price_usd')
    if signed_price is not None and ad_price is not None:
        if int(round(float(signed_price)*100))!=int(round(float(ad_price)*100)):
            reasons.append('Ad price differs from creator-endorsed price')
    signed_sku=signed_claims.get('sku');ad_sku=candidate_claims.get('sku')
    if signed_sku and ad_sku and signed_sku.casefold()!=ad_sku.casefold():
        reasons.append('Ad product SKU differs from creator-endorsed SKU')
    signed_product=signed_claims.get('product');ad_product=candidate_claims.get('product')
    notes=[]
    if signed_product and ad_product and signed_product.strip().casefold()!=ad_product.strip().casefold():
        notes.append('Product wording differs; labels alone do not prove a different SKU')
    return {'status':'MISMATCH' if reasons else 'CONSISTENT','reasons':reasons,'notes':notes,'review_only':True}

# Optional heavyweight local vision and audio models; install requirements-ai.txt.
_clip_model=None
_whisper_model=None

def clip_similarity(image_list_a,image_list_b):
    """Real CLIP image embeddings, only when ENABLE_LOCAL_AI=1."""
    global _clip_model
    if os.getenv('ENABLE_LOCAL_AI')!='1':return {'mode':'UNAVAILABLE','reason':'ENABLE_LOCAL_AI=1 is required'}
    try:
        from sentence_transformers import SentenceTransformer,util
        if _clip_model is None:_clip_model=SentenceTransformer('clip-ViT-B-32')
        a=_clip_model.encode(image_list_a,convert_to_tensor=True,normalize_embeddings=True)
        b=_clip_model.encode(image_list_b,convert_to_tensor=True,normalize_embeddings=True)
        score=float(util.cos_sim(a,b).max())
        return {'mode':'REAL_CLIP','model':'clip-ViT-B-32','max_cosine':round(score,4),'warning':'Similarity is evidence, not proof of ownership or fraud'}
    except Exception as e:return {'mode':'ERROR','reason':str(e)}

def video_transcript(buf):
    """Real faster-whisper transcription using ffmpeg audio; no speech or face identification."""
    global _whisper_model
    if os.getenv('ENABLE_LOCAL_AI')!='1':return {'mode':'UNAVAILABLE','reason':'ENABLE_LOCAL_AI=1 is required'}
    try:
        from faster_whisper import WhisperModel
        with tempfile.TemporaryDirectory() as d:
            video=Path(d)/'video.mp4';audio=Path(d)/'audio.wav';video.write_bytes(buf)
            subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(video),'-vn','-ac','1','-ar','16000',str(audio)],capture_output=True,check=True,timeout=40)
            if _whisper_model is None:_whisper_model=WhisperModel('tiny',device='cpu',compute_type='int8')
            segments,info=_whisper_model.transcribe(str(audio),beam_size=3)
            transcript=' '.join(s.text.strip() for s in segments)
        return {'mode':'REAL_WHISPER','model':'faster-whisper tiny','language':info.language,'transcript':transcript}
    except Exception as e:return {'mode':'ERROR','reason':str(e)}

def compare_videos(original,suspicious):
    reference=video_fingerprints(original);candidate=video_fingerprints(suspicious)
    outcome={'hash_match':compare_frames(reference,candidate),'reference_frames':len(reference),'candidate_frames':len(candidate)}
    if os.getenv('ENABLE_LOCAL_AI')=='1':
        try:outcome['clip']=clip_similarity(frames(original),frames(suspicious))
        except Exception as e:outcome['clip']={'mode':'ERROR','reason':str(e)}
        outcome['reference_speech']=video_transcript(original)
        outcome['candidate_speech']=video_transcript(suspicious)
    else:outcome['ai_status']='UNAVAILABLE: Set ENABLE_LOCAL_AI=1 and install requirements-ai.txt'
    return outcome
