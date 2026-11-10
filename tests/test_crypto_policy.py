from app import crypto,ai

def test_signature_tampering():
    priv,pub=crypto.generate_key()
    payload={'sku':'A','payee_id':'MERCHANT_1','max_price_usd':'49.00'}
    sig=crypto.sign(priv,payload)
    assert crypto.verify(pub,payload,sig)
    assert not crypto.verify(pub,{**payload,'payee_id':'ATTACKER'},sig)
    assert not crypto.verify(pub,{**payload,'max_price_usd':'999.00'},sig)

def test_fingerprint_mirror():
    from PIL import Image,ImageOps,ImageDraw
    im=Image.new('RGB',(100,100),'black');ImageDraw.Draw(im).rectangle((3,10,45,80),fill='white')
    a={'hash':ai.ahash(im),'mirror_hash':ai.ahash(ImageOps.mirror(im))}
    mirrored={'hash':ai.ahash(ImageOps.mirror(im)),'mirror_hash':ai.ahash(im)}
    r=ai.compare_frames([a],[mirrored])
    assert r['minimum_hamming']==0
    assert r['potential_copy']

def test_claim_comparison_is_deterministic():
    x=ai.compare_offer({'sku':'A','price_usd':49},{'sku':'B','amount':'79.00','merchant_name':''})
    assert x['status']=='MISMATCH'
    assert len(x['reasons'])==2
