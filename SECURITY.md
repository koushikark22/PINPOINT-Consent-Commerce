# Security

## Reporting vulnerabilities

Please avoid opening public issues containing credentials, customer data, or reproducible sensitive information. Use the repository owner's GitHub profile contact channels for private disclosure.

## Credential handling

- Do not commit PayPal client secrets, AI API keys, administrator tokens, private signing keys, or environment-specific authentication details.
- Use environment variables or a deployment provider's secret manager for credentials.
- Commit only sanitized example configuration.
- Never store production credentials in browser JavaScript or publish personal PayPal Sandbox login credentials.
- Rotate and revoke any credential accidentally disclosed.

## Payment controls

PayPal operations must be performed by an authorized merchant or appropriately permitted partner. Creator signatures express endorsement policy; they are not PayPal credentials. AI model output must not independently authorize payment capture.

## Demo boundaries

Distinguish simulated gateway actions from actual PayPal Sandbox operations in both API responses and the interface. Do not represent Sandbox transactions as real-money payments.

## Release checks

Verify dependency licenses, remove test artifacts containing transaction information, scan the source and Git history for secrets, test every payment outcome, and check the deployed environment before announcing release.
