![Vallkey ruby](https://raw.githubusercontent.com/vallkeyhq/developer-tools/main/assets/covers/ruby.png)

# vallkey (Ruby)

Route ghost-key requests through [Vallkey](https://vallkey.com) using the supported HTTP clients below. Requests that carry a ghost key go to Vallkey, which swaps in the real key under your rules. Every other request is left alone.

```sh
gem install vallkey
RUBYOPT=-rvallkey/auto bundle exec rails server
```

Using `bundle exec`? Add `gem "vallkey"` to your Gemfile too: Bundler only loads the gems it lists.

Covers Net::HTTP, used by SDKs configured for this transport (Stripe, OpenAI, Anthropic, AWS, and Twilio, Octokit and Slack through Faraday).

| Setting           | What it does                                           |
| ----------------- | ------------------------------------------------------ |
| `VALLKEY_API`     | The Vallkey server (default `https://api.vallkey.com`) |
| `VALLKEY_AUTO=0`  | Turns it off                                           |
| `VALLKEY_DEBUG=1` | Logs each request sent to Vallkey (never the key)      |

## Compatibility and security

Read the [transport boundaries](https://github.com/vallkeyhq/developer-tools/blob/main/docs/compatibility.md) and [security policy](../SECURITY.md). Local transport tests do not certify every SDK version or cloud deployment. Use a dedicated key and verify requests from the actual application after deployment.
