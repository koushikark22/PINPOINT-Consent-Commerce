# Hosting two PINPOINT interfaces

The provided `render.yaml` creates two free-tier web services from the same repository. **This configuration is MOCK-only** and is not suitable for real or Sandbox payment processing.

1. Import the public repository into [Render](https://dashboard.render.com/), choose **New → Blueprint**.
2. Select the free plan for both services. Do not upgrade or attach a paid disk.
3. Set Studio `APP_ORIGIN` to the Market URL (`https://pinpoint-market-demo.onrender.com` or the actual assigned URL).
4. Set Market `PINPOINT_BACKEND` to the Studio HTTPS URL.
5. Set Market `PINPOINT_STUDIO_URL` to the Studio HTTPS URL.
6. Deploy, then visit both assigned URLs. Refresh the Market page after Studio is ready.
7. Test the mock approval, authorization, signed-policy creation, and blocked checkout. Note that Market does not expose merchant capture/void actions.

## Important limitations

Render Free services spin down after 15 minutes without traffic and do not retain SQLite filesystem changes across restarts/redeploys. Free services cannot attach persistent disks. The app's policy and payment records may reset, so this is a **nonpersistent public prototype**. A separately engineered persistent datastore plus authorization controls are required for reliable Sandbox deployments. Free Render Postgres expires after 30 days and the current source uses SQLite, so switching databases is not a drop-in environment change.

The free-tier hours and quotas are shared at workspace level. Some bandwidth/build overages can incur charges if a payment method and applicable spending settings permit them. Monitor your Render workspace billing page; never select a paid plan unintentionally.

This Blueprint deliberately does **not** configure PayPal or AI secrets. The full integration should be tested in a controlled, secured environment with dedicated test credentials and durable state.
