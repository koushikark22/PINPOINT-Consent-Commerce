import base64,hashlib,json
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey,Ed25519PublicKey
from cryptography.hazmat.primitives import serialization

def canonical(value):
    return json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode('utf-8')
def b64(value): return base64.urlsafe_b64encode(value).decode().rstrip('=')
def unb64(value): return base64.urlsafe_b64decode(value+'='*(-len(value)%4))
def generate_key():
    private=Ed25519PrivateKey.generate()
    return b64(private.private_bytes(serialization.Encoding.Raw,serialization.PrivateFormat.Raw,serialization.NoEncryption())),b64(private.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw))
def sign(private,policy): return b64(Ed25519PrivateKey.from_private_bytes(unb64(private)).sign(canonical(policy)))
def verify(public,policy,signature):
    try:
        Ed25519PublicKey.from_public_bytes(unb64(public)).verify(unb64(signature),canonical(policy))
        return True
    except (ValueError,TypeError,Exception): return False

def digest(data): return hashlib.sha256(canonical(data)).hexdigest()
