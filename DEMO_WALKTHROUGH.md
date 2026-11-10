# Under-three-minute demonstration storyboard

Use your own fictional Dana Cole video and screenshots. Record **only behaviors already tested in the deployed application**. When showing Sandbox results, display genuine authorization IDs, raw REST API read-backs and the gateway refusal. If the external Sandbox integration has not been tested, do not present those scenes as real.

| Time | Proof to display |
|---|---|
| 0:00–0:15 | Problem: a creator's trusted endorsement drives shopping; a swapped offer can betray that trust. Scope: participating checkout. |
| 0:15–0:40 | Dana Cole uses browser-held Ed25519 to sign exact merchant, SKU, ceiling and expiry. |
| 0:40–1:05 | Clean Sandbox buyer-approved order: AUTHORIZE and CAPTURE, then real PayPal authorization read-back. |
| 1:05–1:30 | Second order, creator-content attribution, live model claim extraction comparing original endorsement to altered ad. `HELD_FOR_REVIEW` appears. |
| 1:30–2:03 | Dana signs VOID for only the held order. Merchant-side PayPal REST request voids it. Clean sibling remains captured. |
| 2:03–2:20 | Security Lab sends actual capture-after-void request; display exact PayPal HTTP error and fresh VOIDED read-back. |
| 2:20–2:42 | Policy tampering, price mismatch and out-of-scope non-participating checkout shown accurately. |
| 2:42–2:55 | Explain differentiated creator signer and evidence-only AI, then repo URL and hosted demo URL. |

**Do not call pHash AI.** Do not claim global scam blocking, a PayPal-operated service, biometric verification, escrow, guaranteed capture, or guaranteed dispute outcomes.
