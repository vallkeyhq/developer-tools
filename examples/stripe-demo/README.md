# Stripe through Vallkey

List test-mode customers using the official Stripe SDK and a Vallkey ghost key. The example makes one read request; it does not create customers, payments or refunds and does not print customer data.

1. Create a ghost key in Vallkey from a Stripe test-mode secret key.
2. Allow `GET /v1/customers` in that ghost key’s rules.
3. Install dependencies and run the example:

```sh
npm ci
STRIPE_GHOST_KEY='<your-ghost-key>' npm start
```

The script uses `api.vallkey.com` by default. Set `VALLKEY_API` to another trusted HTTPS gateway origin when needed; loopback HTTP is allowed for local testing. A ghost key’s shape does not prove that its underlying Stripe key is a test key: use a dedicated test account and credential.

The only SDK configuration needed to route the request is the gateway host, protocol and port. Credentials remain in the authorization header; the gateway enforces the ghost key’s rules.
