# PINPOINT architecture

> Design reference. The deployable source has not yet been imported into this repository.

PINPOINT consists of two browser interfaces and a payment-policy backend:

| Component | Purpose | Development port |
| --- | --- | --- |
| PINPOINT Market | Product browsing, creator-endorsed offers, buyer checkout | 8878 |
| Scenario Studio | Signed policies, security scenarios, review decisions, evidence | 8877 |
| Backend | Policy verification, AI advisory analysis, PayPal Sandbox operations, status read-back | Integrated with local application |

## Transaction lifecycle

1. The creator establishes signed purchase terms, including product, merchant, price constraints, domain, and validity.
2. The buyer selects an offer in Market.
3. The backend checks signed policy and checkout details. An invalid checkout is rejected before creating a PayPal order where possible.
4. A PayPal Sandbox buyer approves an authorization when the flow reaches the gateway.
5. The backend verifies relevant order and authorization details against the pinned policy.
6. A valid transaction can be captured; a reviewable mismatch can be held for a creator decision; disallowed or expired authorizations can be voided through merchant-authorized operations.
7. The final state is verified from PayPal gateway read-back and surfaced in Studio.

## Trust boundaries

- A creator signs an endorsement policy, not a PayPal payment command.
- AI evidence assists review and cannot independently capture money.
- Browser clients must not receive PayPal client secrets or server admin credentials.
- Payment operations require merchant or authorized partner credentials.
- An advisory state such as `HELD_FOR_REVIEW` must not be confused with a completed capture.

## Modes

- **MOCK:** explicitly labeled simulated gateway operations.
- **SANDBOX:** actual calls to the PayPal test environment, using test accounts only.

## Publication state

This document describes the intended architecture based on the existing local build. The final release requires the source import, dependency audit, integration tests, environment configuration, and hosting verification.
