import Stripe from 'stripe';

const ghostKey = process.env.STRIPE_GHOST_KEY;
if (!ghostKey?.startsWith('gk_stripe_')) {
  console.error('Set STRIPE_GHOST_KEY to your dedicated Stripe test ghost key.');
  process.exit(1);
}

let gateway;
try {
  gateway = new URL(process.env.VALLKEY_API || 'https://api.vallkey.com');
} catch {
  console.error('VALLKEY_API must be a valid gateway origin.');
  process.exit(1);
}
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(gateway.hostname);
if (
  (gateway.protocol !== 'https:' && !(gateway.protocol === 'http:' && loopback)) ||
  gateway.username ||
  gateway.password ||
  gateway.pathname !== '/' ||
  gateway.search ||
  gateway.hash
) {
  console.error('VALLKEY_API must be an HTTPS origin; HTTP is allowed only for loopback tests.');
  process.exit(1);
}

const stripe = new Stripe(ghostKey, {
  host: gateway.hostname,
  protocol: gateway.protocol === 'http:' ? 'http' : 'https',
  port: gateway.port ? Number(gateway.port) : undefined,
  maxNetworkRetries: 0,
  timeout: 10_000,
});

try {
  const customers = await stripe.customers.list({ limit: 1 });
  console.log(`Request succeeded. Returned ${customers.data.length} customer(s); customer data omitted.`);
} catch (error) {
  console.error(
    `Request failed (${error instanceof Stripe.errors.StripeError ? error.statusCode || error.type : 'connection error'}). Check the key’s Activity in Vallkey.`,
  );
  process.exitCode = 1;
}
