# What the relay's licence means in practice

**This file is a plain-English summary. It is not legal advice and it is not
binding.** The binding terms are in [`LICENSE`](./LICENSE) (Functional Source
License, Version 1.1, ALv2 Future License — SPDX `FSL-1.1-ALv2`). Where this
summary and `LICENSE` disagree, `LICENSE` wins.

## The short version

**You can self-host the Tabsend relay. That is allowed, and it always will be.**

Running your own relay — on your laptop, on a Raspberry Pi in your hallway, on
a VPS, or on your employer's servers — is a permitted use. You do not need
permission and you do not owe anything.

That covers:

- Running it **for yourself**.
- Running it **for your family or household**.
- Running it **for your company, school, club, or other organisation**, for
  that organisation's own people — including if the organisation is a business
  and including if it is a large one.
- **Reading, studying, and modifying** the source, and running your modified
  version for any of the above.
- **Redistributing** it, including your changes, as long as you pass these same
  terms along and keep the copyright notices intact.
- Using it in **non-commercial education and research**.
- Running it for a client **as part of professional services you provide**,
  where that client is itself using the software under these terms.

## The one thing you cannot do

You cannot take the relay and **offer it to other people as a commercial
product or service that competes with Tabsend** — a hosted "Tabsend as a
service" for third parties, or a commercial product that substitutes for
Tabsend or does substantially the same thing.

That single restriction is the whole point of the licence. It is aimed at
commercial re-hosting, not at users.

## The rule of thumb

Ask who the relay is serving:

- **Serving you and your own people?** Permitted. Go ahead.
- **Serving third parties, commercially, as a substitute for Tabsend?** Not
  permitted while the FSL term is running.

## It becomes Apache-2.0 anyway

The FSL is time-limited. **Each released version of the relay automatically
converts to the Apache License, Version 2.0 two years after that version is
made available.** The conversion is an irrevocable grant made up front in the
licence itself — it is not a promise that can be withdrawn later.

So any relay version older than two years may be used by anyone under plain
Apache-2.0, including for the commercial use that would otherwise be excluded.
Note that the clock runs **per version**, not once for the project as a whole.

## What about the rest of Tabsend?

Only `server/` (the relay) is under the FSL. **Everything else in this
repository is Apache-2.0**, including `shared/`, the browser extension, the
Android app, and the web console. `shared/` is Apache-2.0 by design, so the
clients can depend on it freely. See the root `LICENSE` and `NOTICE`.

## Still unsure?

If your situation does not obviously fall on one side of the line, ask by
opening an issue on the project's GitHub page.
