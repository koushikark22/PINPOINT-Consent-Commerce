# PINPOINT — Consent Commerce

PINPOINT is a creator-consent and checkout-integrity application. It combines creator-signed purchase policies, AI-assisted promotional-claim review, and merchant-controlled PayPal payment authorization workflows.

## Components

- **PINPOINT Market** — product discovery and buyer checkout.
- **Scenario Studio** — creator policy management, transaction demonstrations, decision evidence, and security review.
- **Payment backend** — policy validation, PayPal Sandbox authorization, capture or void, and gateway status read-back.

## Status

This repository is being prepared for a reproducible public release. The application source, deployment configuration, and verified startup instructions have **not yet been published** here. This README is not a working deployment.

The intended interfaces currently run in the developer environment on ports **8878** (Market) and **8877** (Scenario Studio). Local ports are not public URLs.

## Security model

Creators sign policy records; the backend verifies signed terms against checkout details. AI analysis is advisory: it can supply evidence and trigger review, but it cannot independently authorize a payment. PayPal capture and void require authorized merchant or partner credentials.

Simulation and PayPal Sandbox results must be explicitly distinguished. Sandbox transactions do not move real funds.

## Configuration

Never commit real API keys, OAuth credentials, signing private keys, runtime databases, or local environment files. A sanitized example configuration and full installation instructions will accompany the verified application release.

## License

MIT. See [LICENSE](LICENSE).
