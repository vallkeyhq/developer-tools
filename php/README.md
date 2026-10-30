# vallkey (PHP extension)

Route ghost-key requests through [Vallkey](https://vallkey.com) using the supported HTTP clients below. Requests that carry a ghost key go to Vallkey, which swaps in the real key under your rules. Every other request is left alone.

Intercepts the supported entry points in PHP's curl extension: Guzzle, Symfony HttpClient, and the SDKs' own clients (Stripe, Twilio, SendGrid, OpenAI, Anthropic, AWS…). PHP 8.0 and later.

```sh
phpize && ./configure --enable-vallkey && make
mkdir -p /opt/vallkey/php && cp modules/vallkey.so /opt/vallkey/php/
echo "extension=/opt/vallkey/php/vallkey.so" > /opt/vallkey/php/vallkey.ini
PHP_INI_SCAN_DIR=:/opt/vallkey/php php artisan serve
```

The leading `:` keeps PHP's own ini folder and adds this one.

| Setting | What it does |
|---|---|
| `VALLKEY_API` | The Vallkey server (default `https://api.vallkey.com`) |
| `VALLKEY_AUTO=0` | Turns it off |
| `VALLKEY_DEBUG=1` | Logs each request sent to Vallkey (never the key) |

## Compatibility and security

Read the [transport boundaries](https://github.com/vallkeyhq/developer-tools/blob/main/docs/compatibility.md) and [security policy](../SECURITY.md). Local transport tests do not certify every SDK version or cloud deployment. Use a dedicated key and verify requests from the actual application after deployment.
