# Tabsend wake-up forwarder

A tiny service that rings phones. That is all it does.

An iPhone cannot hold a connection open in the background, and the only reliable way to wake
one is Apple's push service, which takes instructions only from a key Apple issues to a paid
developer account. That key cannot be handed out: it is not per-user, and anyone holding it
could notify every Tabsend user. So a relay in your flat has no way to wake your phone,
however well configured it is. Not a networking problem. Apple will not listen to it.

**Android uses it for a different reason.** An Android phone *can* hold a connection open,
but Android makes it show a permanent notification for doing so. Google's push service needs
no such thing — and, exactly like Apple's, it takes instructions only from a credential that
cannot be handed to self-hosters. So the same doorbell serves both: an Android phone that
would rather not carry the notification registers here too, and the relay rings this service
instead of the phone holding a connection up all day.

This service is the doorbell, and it is the only piece of project-run infrastructure in
Tabsend.

> **Your data stays on your relay. We only ring the doorbell.**

Your relay calls this service with a token that means "ring that phone". It tells Apple or
Google to ring the phone. The phone wakes up and fetches from **your relay**, which is where
your data was the whole time. Nothing you send passes through here, because there is nowhere
in the request for it to go: the wake request carries a token and nothing else, and the push
delivered is empty.

**One service, called the same way by every relay.** A hosted Tabsend relay and a
self-hosted one point at the same URL and get the same treatment. The hosted side gets no
private key and no shortcut. That is deliberate: waking phones is one thing built once,
not a hosted feature a self-hoster later has to ask for.

## The metadata cost, stated plainly

Running any doorbell means someone can hear it ring. Here is exactly what that is worth:

> The forwarder learns that a device received something, and when. Never what.

It does not learn what the message was, who sent it, which browser or which tab, your
email address, or your name. There is no account here to attach any of that to. It does
see the network address of the relay that rings it, as any web service sees its callers,
and your phone's address when the phone signs up; it keeps those in memory for its rate
limits, at most two windows after the last call (two minutes, or twenty for sign-ups),
and never writes them down or logs them. It holds, per phone: the address Apple or Google
gave your phone, encrypted under a key the operator keeps outside the database, a hash of
the token your phone was issued, when that token was minted, when it was last rung, and
how many times.
No per-message record exists, so the hundredth ring leaves exactly as much trace as the
first.

[`PROTOCOL.md`](PROTOCOL.md) §5 is the field-by-field version, including why keeping this
much still honours the plan's "hold no state" intent.

## What happens when it is down

**Delivery degrades to drain-on-open, which is exactly the behaviour of no forwarder at
all.** Nothing is lost. Your message is on your relay, and your phone picks it up the next
time you open the app, or the next time a wake gets through. An Android phone on Google
push is the one exception: it closed its own connection when it signed up here, so until
it notices, it picks tabs up when it checks in, every few minutes.

That contract binds the relay side too, and is worth stating here because this is where
someone will look for it:

- **A relay treats a wake as best-effort and never lets it fail a send.** A wake that
  times out, gets rate-limited, or cannot connect is logged and dropped. It never turns
  into a failed send, a rejected item, or an error shown to a user. A send that reached
  your relay succeeded, whatever the doorbell did afterwards.
- **A relay with no forwarder configured behaves exactly as it does today.** No wake;
  iPhones drain on open and Android phones keep their own connection; no warning.

## Running your own

You need an Apple developer account to ring iPhones, and a Firebase project to ring
Android phones (which also means your own build of the Android app carrying that project's
values, since a phone signs up with the forwarder built into its app). With either, nothing
about this service is special to the project's instance, which is the point of publishing
it.

1. In the Apple developer portal, create an **APNs Auth Key** and download the `.p8`. Note
   the **key id** shown beside it and your **team id**.
2. Make the key that encrypts each phone's address in the database, once, and keep it
   with your other secrets. It must not live beside the database file or go into its
   backups: a copy of the database is worth nothing without it, and that is the point.

   ```sh
   openssl rand -base64 32 > /etc/tabsend/device-token.key
   ```

   ```sh
   chmod 600 /etc/tabsend/device-token.key
   ```

   Keep it safe. A forwarder will not start with a different key than the one its database
   was written with, and losing it means every phone has to sign up again.

3. Point the config at the Apple values and the key, plus your app's bundle id:

   ```sh
   export APNS_KEY_PATH=/etc/tabsend/AuthKey_ABCD123456.p8
   export APNS_KEY_ID=ABCD123456
   export APNS_TEAM_ID=TEAM123456
   export APNS_TOPIC=io.tabsend.app
   export DEVICE_TOKEN_KEY_PATH=/etc/tabsend/device-token.key
   export DATABASE_PATH=/var/lib/tabsend/forwarder.db
   pnpm --filter @tabsend/forwarder start
   ```

4. Point a relay at it. The relay-side setting (`WAKE_FORWARDER_URL`) is open and
   configurable; unset means today's behaviour, unchanged.

Put it behind a reverse proxy that terminates TLS, and set `TRUST_PROXY=1` there or every
caller shares one rate-limit bucket.

**Rotating the Apple key** is: put the new `.p8` where the config points, restart. No
device re-registers and no relay is reconfigured, because wake tokens are this service's
own and have nothing to do with Apple's.

For local development with no Apple account at all, `APNS_DRY_RUN=1` starts the service
with no Apple key: every wake is accepted and no phone is rung. It still needs
`DEVICE_TOKEN_KEY`; a throwaway one is fine for a throwaway database. Without the dry run,
a forwarder configured for neither Apple nor Google refuses to start rather than
pretending to work.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Listen address. |
| `PORT` | `8788` | Listen port. Not the relay's 8787, so both can run on one machine. |
| `DATABASE_PATH` | `./.data/forwarder.db` | SQLite file. Created readable by its owner only. |
| `DEVICE_TOKEN_KEY` | — | Required. 32 random bytes as base64 (`openssl rand -base64 32`). Encrypts each phone's push address in the database. Keep it out of the database's backups. |
| `DEVICE_TOKEN_KEY_PATH` | — | The same key read from a file. Set this or `DEVICE_TOKEN_KEY`, not both. |
| `APNS_KEY_PATH` | — | Path to the `.p8`. Set this or `APNS_KEY_PEM`, not both. |
| `APNS_KEY_PEM` | — | The key inline, for a secret store that injects env rather than files. |
| `APNS_KEY_ID` | — | Required. The key id Apple shows beside the `.p8`. |
| `APNS_TEAM_ID` | — | Required. Your 10-character Apple team id. |
| `APNS_TOPIC` | `io.tabsend.app` | The app bundle id. |
| `APNS_DEFAULT_ENVIRONMENT` | `production` | Used when a registration does not name one. |
| `APNS_TIMEOUT_MS` | `5000` | Ceiling on one call to Apple. |
| `APNS_DRY_RUN` | off | Start with no Apple key and ring nobody. Local development only. |
| `TRUST_PROXY` | off | Read `X-Forwarded-For` for the per-caller rate limit. Set it behind a proxy. |
| `MAX_BODY_BYTES` | `4096` | Bodies here are one short string. |
| `FCM_SERVICE_ACCOUNT_PATH` | — | Firebase service-account JSON, for ringing Android phones. Without it (or `FCM_SERVICE_ACCOUNT_JSON`, or `FCM_DRY_RUN=1`) this forwarder refuses Android registrations with `501`; iPhones are unaffected. NOT `google-services.json` — that is the client config inside the app and carries no credential. |
| `FCM_SERVICE_ACCOUNT_JSON` | — | The same credential inline. Exactly one of the two. |
| `FCM_TIMEOUT_MS` | `5000` | Per-request ceiling on the Google call. |
| `FCM_DRY_RUN` | off | Accept Android wakes and ring nobody. Local development only. |
| `WAKE_RATE_LIMIT_MAX` / `WAKE_RATE_LIMIT_WINDOW_SECONDS` | `6` / `60` | Rings allowed per phone. |
| `CALLER_RATE_LIMIT_MAX` / `CALLER_RATE_LIMIT_WINDOW_SECONDS` | `120` / `60` | Rings allowed per calling relay. |
| `REGISTER_RATE_LIMIT_MAX` / `REGISTER_RATE_LIMIT_WINDOW_SECONDS` | `10` / `600` | Registrations per address. |
| `LOG_LEVEL` | `info` | Log verbosity. |

## API in one screen

Full details, and the reasoning behind each choice, are in
[`PROTOCOL.md`](PROTOCOL.md).

| Route | Caller | Auth | Answer |
|---|---|---|---|
| `POST /v1/register` | the iOS or Android app | none | `{ "apnsToken": … }` or `{ "fcmToken": … }`, exactly one. Returns `{ "wakeToken": "…" }`. Registering the same phone again replaces its old token. |
| `POST /v1/wake` | any relay | wake token in `Authorization: Bearer` | `202 { "status": "accepted" }`, always. Which provider is rung is this service's business; no caller is told. |
| `POST /v1/revoke` | the iOS or Android app | wake token in `Authorization: Bearer` | `200 { "status": "ok" }`, always. |
| `GET /healthz` | anyone | none | `{ "status": "ok", … }`. |

Three things about that table are load-bearing:

- **A wake token never travels in a URL**, only in a header. URLs end up in proxy logs and
  shell history; ADR-0009 put the pairing secret in a link fragment for the same reason.
- **Wake and revoke answer identically whether the token is live, revoked, or invented.**
  Otherwise anyone on the internet could use this service to test whether a token they
  found still works. The cost is that a relay cannot tell a successful ring from a dead
  token, which is fine, because a relay treats every wake as best-effort anyway.
- **A leaked token rings exactly one phone, until that phone notices.** Re-registering
  replaces it, unpairing revokes it, and rate limits bound what it can do in the meantime.

## Development

```sh
pnpm --filter @tabsend/forwarder test
pnpm --filter @tabsend/forwarder typecheck
pnpm exec biome check forwarder
```

Every APNs and FCM interaction in the test suite runs against a fake sender, so the suite
needs no Apple account or Firebase project and touches no network.

## Licence

Apache-2.0 ([`LICENSE`](LICENSE)). Published source, deliberately: "we only ring the
doorbell" is a claim, and a claim about a service you cannot read is worth very little.
The relay in `server/` is the one part of Tabsend under a different licence.
