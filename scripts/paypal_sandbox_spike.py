"""Run a genuine, buyer-approved PayPal Sandbox authorization spike.

Proof of merchant API capability, not creator-policy enforcement.
Run twice, once with --action capture and once with --action void.
Requires .env with PAYMENT_MODE=sandbox and disposable accounts.
"""
import argparse
import asyncio
import json
import uuid
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from datetime import datetime, timezone
from app.config import MODE, MERCHANT
from app.paypal import SandboxGateway, GatewayError


async def smoke(action: str, amount: str) -> None:
    if MODE != "sandbox":
        raise SystemExit("Refusing to run: set PAYMENT_MODE=sandbox in your private .env")
    if not MERCHANT:
        raise SystemExit("PAYPAL_MERCHANT_ID must identify the Sandbox Business account")
    gateway = SandboxGateway()
    ref = "PINPOINT-SPIKE-" + uuid.uuid4().hex[:12]
    create = await gateway.create(amount, "PINPOINT-SANDBOX-SPIKE", "create-" + ref)
    order_id = create["id"]
    approval = next((link.get("href") for link in create.get("links", [])
                    if link.get("rel") in ("approve", "payer-action")), None)
    if not approval:
        raise SystemExit("Order created but no buyer approval URL returned. Inspect PayPal response.")
    print("\nPAYPAL SANDBOX (NOT PRODUCTION)")
    print("Order ID:", order_id)
    print("Open this buyer approval URL and log in with your Sandbox PERSONAL account:")
    print(approval)
    input("\nAfter you APPROVE the order on PayPal, press Enter to continue...")
    verified_order = await gateway.get_order(order_id)
    if verified_order.get("status") != "APPROVED":
        raise SystemExit("Buyer approval not confirmed. Order status: " + str(verified_order.get("status")))
    authorized = await gateway.authorize(order_id, "authorize-" + ref)
    units = authorized.get("purchase_units", [])
    authorizations = [a for u in units for a in u.get("payments", {}).get("authorizations", [])]
    if len(authorizations) != 1:
        raise SystemExit("Expected one PayPal authorization, got " + str(len(authorizations)))
    auth_id = authorizations[0]["id"]
    before = await gateway.get_authorization(auth_id)
    print("Authorization ID:", auth_id)
    print("Authorization status BEFORE:", before.get("status"))
    if action == "capture":
        result = await gateway.capture(auth_id, "capture-" + ref)
        probe = None
    else:
        result = await gateway.void(auth_id, "void-" + ref)
        try:
            unexpectedly_captured = await gateway.capture(auth_id, "proof-after-void-" + ref)
            probe = {"unexpected_success": True, "result": unexpectedly_captured}
        except GatewayError as exc:
            probe = {"expected_refusal": True, "http_status": exc.code, "raw_gateway_error": exc.details}
    after = await gateway.get_authorization(auth_id)
    data = {
        "note": "Real Sandbox API spike only; no creator policy enforcement exercised",
        "action": action,
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "order_id": order_id,
        "authorization_id": auth_id,
        "before": before,
        "operation": result,
        "capture_after_void_probe": probe,
        "after": after,
    }
    output_dir = Path("artifacts")
    output_dir.mkdir(exist_ok=True)
    output = output_dir / ("paypal_spike_" + action + "_" + ref + ".json")
    output.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print("\nFINAL READ-BACK STATUS:", after.get("status"))
    if probe is not None:
        print("Capture-after-void probe:", json.dumps(probe, indent=2))
    print("Saved private evidence:", output)
    print("Do not commit artifacts: they may contain Sandbox buyer/merchant identifiers.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Genuine PayPal Sandbox authorize/capture/void capability spike")
    parser.add_argument("--action", choices=["capture", "void"], required=True)
    parser.add_argument("--amount", default="1.00", help="small USD test amount; default 1.00")
    args = parser.parse_args()
    from decimal import Decimal
    if not Decimal("0.01") <= Decimal(args.amount) <= Decimal("5.00"):
        parser.error("Spike amount must be between $0.01 and $5.00")
    try:
        asyncio.run(smoke(args.action, f"{Decimal(args.amount):.2f}"))
    except GatewayError as exc:
        print("PAYPAL API ERROR (verbatim details):", json.dumps(exc.details, indent=2))
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
