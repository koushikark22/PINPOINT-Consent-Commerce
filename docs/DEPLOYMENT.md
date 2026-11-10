# Deployment plan

> Not yet a deployable release. Source files and verified production startup commands are pending import.

## Target

Deploy PINPOINT Market and Scenario Studio behind HTTPS endpoints, with the backend reachable only through the intended browser application interfaces.

## Required deployment checks

1. Import the audited Market, Studio, and backend source files.
2. Supply separate environment variables for PayPal Sandbox and the AI provider. Never commit keys.
3. Configure a persistent datastore if the application relies on a local SQLite database. Do not use ephemeral disk storage for durable payment state.
4. Configure allowed origins, HTTPS redirects, signed-policy verification, secure cookies or headers, and least-privilege admin access.
5. Confirm no endpoint exposes confidential credentials, signing private keys, raw administrative tokens, or arbitrary internal URLs.
6. Verify PayPal Sandbox authorization, capture, void, rejection handling, webhook verification where applicable, and status read-back.
7. Verify both websites display consistent payment state, including reloads and multi-session access.
8. Run the complete test suite and a fresh-install test with documented commands.
9. Confirm public access and availability for the expected evaluation period.

## Hosting tradeoffs

Free hosting is not automatically appropriate for transactional state. Some providers suspend idle services or use ephemeral filesystems. A persistent managed datastore or an otherwise verified durable storage strategy is required before claiming reliable availability.

## Public access

Never publish test buyer passwords or confidential API keys in the repository. Provide a public read-only demonstration mode where feasible, and document separately how reviewers can use their own Sandbox credentials for gateway tests.

## Release gate

Do not describe the application as hosted or reproducible until both public URLs, a clean installation, and end-to-end payment outcomes are verified.
