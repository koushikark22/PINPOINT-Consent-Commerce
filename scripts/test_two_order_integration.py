import os
import uuid
import json
import sqlite3
import sys
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))

# Load only AI configuration
for line in Path(".env").read_text(encoding="utf-8-sig").splitlines():
    if "=" not in line or line.lstrip().startswith("#"):
        continue
    k, v = line.split("=", 1)
    if k.strip() in ("AI_API_URL", "AI_API_KEY", "AI_MODEL"):
        os.environ[k.strip()] = v.strip().strip('"').strip("'")

assert all(os.getenv(x) for x in (
    "AI_API_URL", "AI_API_KEY", "AI_MODEL"
)), "AI configuration missing"

db = str(
    (ROOT / "artifacts" /
     ("mock_complete_" + uuid.uuid4().hex[:10] + ".sqlite3")).resolve()
)

os.environ.update({
    "PAYMENT_MODE": "mock",
    "PAYPAL_MERCHANT_ID": "MOCK_MERCHANT_001",
    "DB_PATH": db,
    "APP_ORIGIN": "http://localhost:8000",
    "DEMO_ADMIN_TOKEN": "local-integration-only",
    "PUBLIC_MOCK_JUDGE_MODE": "0",
    "PUBLIC_SANDBOX_JUDGE_MODE": "0",
    "AUTO_SETTLE_SECONDS": "0",
    "REVIEW_TIMEOUT_SECONDS": "600"
})

from fastapi.testclient import TestClient
from app.main import app
from app import crypto

headers = {"X-Demo-Token": "local-integration-only"}

def post(client, path, payload=None):
    r = client.post(path, json=payload, headers=headers)
    print(f"HTTP {r.status_code}: {path}")
    if r.status_code != 200:
        raise RuntimeError(r.text[:500])
    return r.json()

def state(payment_id):
    with sqlite3.connect(db) as conn:
        row = conn.execute(
            "SELECT state FROM payment WHERE id=?",
            (payment_id,)
        ).fetchone()
        return row[0] if row else None

def signed_review(client, payment_id, policy_id, private_key, action):
    record = {
        "payment_id": payment_id,
        "policy_id": policy_id,
        "action": action,
        "reason": "PINPOINT integration test",
        "time": datetime.now(timezone.utc).isoformat()
    }

    signature = crypto.sign(private_key, record)

    return post(
        client,
        f"/api/payments/{payment_id}/creator-review",
        {
            "action": action,
            "reason": record["reason"],
            "creator_time": record["time"],
            "creator_signature": signature
        }
    )

with TestClient(app) as client:

    print("\n=== 1. CREATE POLICY ===")

    policy = post(client, "/api/policies", {
        "creator_label": "PINPOINT Test Creator",
        "sku": "PIN-101",
        "domain": "localhost",
        "max_price_usd": "5.00",
        "review_timeout_seconds": 600,
        "claims": (
            "I recommend SKU PIN-101 "
            "from Demo Store for $19.99."
        )
    })

    assert policy["status"] == "ACTIVE"
    policy_id = policy["id"]
    content_id = "content-" + uuid.uuid4().hex[:10]

    with sqlite3.connect(db) as conn:
        private_key = conn.execute(
            "SELECT private_key FROM creator WHERE id=?",
            (policy["payload"]["creator_id"],)
        ).fetchone()[0]

    print("PASS: Creator policy ACTIVE")

    print("\n=== 2. AUTHORIZE TWO MOCK ORDERS ===")

    payments = []

    for name in ("A", "B"):
        checkout = post(client, "/api/checkouts", {
            "policy_id": policy_id,
            "amount": "1.00",
            "sku": "PIN-101",
            "domain": "localhost",
            "content_id": content_id
        })

        payment_id = checkout["payment_id"]

        post(client, f"/api/mock-approve/{payment_id}")

        authorization = post(
            client,
            f"/api/payments/{payment_id}/authorize"
        )

        assert authorization["state"] == "AUTHORIZED"

        payments.append(payment_id)
        print(f"PASS: Order {name} AUTHORIZED")

    print("\n=== 3. REAL GEMINI AI ANALYSIS ===")

    verdict = post(client, "/api/content/analyze", {
        "policy_id": policy_id,
        "content_id": content_id,
        "transcript": (
            "Buy SKU PIN-999 from Demo Store "
            "for $49.99. Recommended by the creator."
        )
    })

    assert verdict["reference"]["mode"] == "LIVE_LLM"
    assert verdict["analysis"]["mode"] == "LIVE_LLM"
    assert verdict["content_verdict"] == "MISMATCH"

    assert set(verdict["affected_payment_ids"]) == set(payments)

    print("PASS: Gemini identified MISMATCH")

    print("\n=== 4. VERIFY BOTH PAYMENT HOLDS ===")

    for name, payment_id in zip(("A", "B"), payments):
        assert state(payment_id) == "HELD_FOR_REVIEW"
        print(f"PASS: Order {name} HELD_FOR_REVIEW")

    print("\n=== 5. CREATOR-SIGNED VOID ===")

    result_a = signed_review(
        client, payments[0], policy_id, private_key, "VOID"
    )

    assert result_a["state"] == "VOIDED"
    assert state(payments[0]) == "VOIDED"

    print("PASS: Order A VOIDED")

    print("\n=== 6. CREATOR-SIGNED APPROVE AND CAPTURE ===")

    result_b = signed_review(
        client, payments[1], policy_id, private_key, "APPROVE"
    )

    assert result_b["state"] == "CAPTURED"
    assert state(payments[1]) == "CAPTURED"

    print("PASS: Order B CAPTURED")

    evidence = {
        "test": "PINPOINT_TWO_ORDER_MOCK",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "model": verdict["analysis"]["model"],
        "ai_mode": verdict["analysis"]["mode"],
        "verdict": verdict["content_verdict"],
        "payment_gateway": "MOCK",
        "signing": "LEGACY_SERVER_HELD_MOCK_TEST_KEY",
        "order_a": {
            "payment_id": payments[0],
            "state": state(payments[0])
        },
        "order_b": {
            "payment_id": payments[1],
            "state": state(payments[1])
        }
    }

    path = Path(db).with_suffix(".evidence.json")
    path.write_text(
        json.dumps(evidence, indent=2),
        encoding="utf-8"
    )

    print("\n====================================")
    print("PINPOINT TWO-ORDER INTEGRATION: PASS")
    print("REAL AI: GEMINI")
    print("ORDER A: VOIDED")
    print("ORDER B: CAPTURED")
    print("PAYMENT MODE: MOCK")
    print("====================================")
    print("Evidence:", path)
    print("Database:", db)
