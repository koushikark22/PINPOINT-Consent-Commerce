# PINPOINT - Consent Commerce

PINPOINT links creator-signed purchase terms to checkout verification and merchant-authorized PayPal payment controls. It includes two connected browser applications:

- **PINPOINT Market:** buyer-facing demo with five product categories.
- **Scenario Studio v6:** creator policies, adversarial scenarios, payment state and evidence.

The implementation supports MOCK mode (simulated gateway) and PayPal Sandbox mode (test transactions). Gemini or another OpenAI-compatible model may provide advisory claims analysis; AI never independently captures funds.

## Local setup

Requires Python 3.11+ and PowerShell on Windows (or an equivalent Python shell on other systems).

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
# Edit .env locally for your environment; never commit it.
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-PINPOINT-Two-Sites.ps1
```

Open `http://127.0.0.1:8877` for Scenario Studio and `http://127.0.0.1:8878` for Market. The default is MOCK, which does not connect to PayPal.

## Payment behavior

1. A creator signs a policy covering merchant, SKU, price ceiling, domain and validity.
2. The buyer selects a product in Market; mismatches can be rejected before a payment order is created.
3. The buyer approves a PayPal Sandbox authorization when enabled.
4. The backend rechecks the pinned terms. Authorized merchant-side settlement may capture or void; suspicious content may trigger a review hold.
5. The server checks the gateway status and exposes evidence to Studio.

**Market does not expose capture/void controls.** The protected flow is intentionally separated from buyer actions. A completed buyer approval is **not** a completed capture.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest tests -q
```

For the separate two-order integration test, configure the optional `.env` AI variables first; it is not required for basic startup.

## Public hosting

A two-service Render Blueprint is provided in `render.yaml` for a **nonpersistent MOCK demonstration only**. It has no real PayPal transactions, and the SQLite database may reset when hosting sleeps/restarts. It is not a production payments deployment. Do not enable PayPal Sandbox publicly unless authenticated access, durable storage, quotas, and authorized merchant permissions are fully configured.

See `docs/DEPLOYMENT.md` for the hosting procedure and limitations.

## Security

- Keep `.env`, all tokens, private keys, credentials, and databases out of version control.
- Do not use live PayPal money or accounts.
- Creator cryptographic signing illustrates signed consent, not verified real-world creator identity.
- A MOCK gateway is never evidence of a successful PayPal Sandbox transaction.
- All published UI, documentation, and tests are for a demonstration system, not a merchant product.

## License

MIT - see [LICENSE](LICENSE). The project is independent and is not endorsed or operated by PayPal.
