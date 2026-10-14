# Relay runbook

**For whoever maintains the running relay — usually an agent on the relay's own machine.**

This is the operations counterpart to `docs/DEPLOY.md`. DEPLOY explains how to stand a
relay up; this explains how to tell whether the one already standing is healthy, what
each finding means, and which repairs are safe.

Everything here assumes you are **on the machine running the relay** (for example a small
Linux machine running `docker-compose.lan.yml`). Nothing here works remotely, by design:
the diagnostics answer only callers on the relay's own host.

---

## 1. The one command

```bash
./scripts/relay-doctor.sh
```

Run it from the Tabsend checkout on the relay machine. It takes no arguments, changes
nothing, and prints everything below in one pass. Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Everything was checked and is healthy. |
| `1` | Problems found. They are listed under **Verdict**. |
| `2` | The essentials could not be checked. What was missed is listed under **Not checked**. |

**Exit code 2 is not "healthy".** It means the answer is unknown. Report it as unknown.
The most common cause is the user not being able to reach the Docker daemon, and the
script prints the exact fix when that happens.

If you only want the relay's own view and the container is known to be up:

```bash
docker exec tabsend-relay server/node_modules/.bin/tsx server/src/scripts/status-report.ts
```

Add `--json` to that for the raw data. There is also `GET /admin/status` on the relay,
which is what both of the above read; it answers loopback callers only, so it must be
requested from inside the container.

---

## 2. Findings and what to do about them

Each `[code]` below is what the doctor prints in brackets.

### The relay is not running

| Finding | What it means | Fix |
| --- | --- | --- |
| Container does not exist | Nothing is serving. Either it was never created here, or it was removed. | `docker compose -f docker-compose.lan.yml up -d --build --wait` |
| State is `exited` | It started and stopped. The doctor prints the last 30 log lines; the cause is almost always in them. | Fix the cause, then `up -d --wait`. Do not just restart a container that exits on a config error, it will exit again. |
| State is `restarting` | Crash loop: it starts, fails, and Docker starts it again. | Read the logs. Restarting will not help. |
| Restarts > 5 | Something crashed it repeatedly, even though it is up now. | Check the log window for the errors around each restart. |
| Health `unhealthy` | It is up but not answering its own health check. | Check whether the port is bound and the database is reachable. |

### The relay is running but reports problems

| Code | What it means | Fix |
| --- | --- | --- |
| `database_unreachable` | The relay cannot read its own database. Nothing works. | Check the volume is mounted and the disk is not full. For Postgres, check the db container. |
| `multiple_groups` | Two separate groups on a relay configured for one. Devices in different groups cannot see each other and **both sides look correctly paired**. This is the failure ADR-0022 exists to prevent. | Owner decision. The fix is to unpair the devices in the wrong group and re-onboard them with a pairing code from a device in the right one. Do not do this unprompted. |
| `no_devices` | Nothing is paired. | The pairing link is printed in the relay log at startup. `docker logs tabsend-relay 2>&1 \| grep pairingLink` Each restart prints another; any of them works until the first device pairs, and then the rest stop working. |
| `single_device` | Only one device paired; nothing can be sent yet. | Expected mid-setup. Tell the owner if it persists. |
| `tabs_waiting` | Tabs have sat in the queue for over an hour. The receiving device is not collecting them. | Check that device's `seen` age in the report. If it is offline, that is the answer. If it is online and still not collecting, that is a client bug worth reporting. |
| `sweeper_idle` | The cleanup job has never run, though it should have. Expired tab contents are not being erased. | A relay defect. Restarting clears it; report it so it gets fixed properly. |
| `sweeper_failing` / `sweeper_behind` | The cleanup job is erroring or falling behind: expired tab contents have outlived several cleanup windows. | Check `Last error` in the report and the log window. |
| `sweeper_disabled` | `SWEEP_INTERVAL_SECONDS=0`, so the cleanup job is switched off and expired tab contents are never erased. A privacy problem, not an availability one. | Remove the override and rebuild. Only correct in a test deployment. |
| `push_dead` | Wake-up messages to a device keep failing. It still receives tabs, but only when it next checks in. | On a browser it usually means the subscription expired; the client rotates it on its next heartbeat, so re-open that browser. Phones never show this: their wake-ups go through the wake-up forwarder or not at all, and the relay does not count a forwarder's answer as a failure (ADR-0032). |
| `device_stale` | A device has not contacted the relay in over two weeks. | Usually just a machine that is off. Worth mentioning, not worth acting on. |
| `internal_errors` | The relay hit unexpected errors. This is a defect, not load. | Report with the `Last error` line. |
| `public_clients_refused` | Requests from outside the local network were turned away at the unencrypted port. | If that port is reachable from the internet, close it at the router. Device tokens travel in the clear on it. |
| `cleartext_public` | `HTTP_ALLOW_PUBLIC` is on, so the unencrypted port accepts anyone. | Only correct on an IPv6 network where the guard blocks legitimate machines. Otherwise turn it off. |
| `stream_at_capacity` | The live-connection pool is nearly full. New connections get refused and delivery falls back to slow polling. | Unexpected on a household relay. Report it. |

### Other findings

| Finding | What it means | Fix |
| --- | --- | --- |
| Disk ≥ 90% full | When it fills, pairing and sending stop. | Free space on the host. Do **not** delete anything under `/data`. |
| Error lines in the log | Something failed within the log window. | The doctor prints the five most recent. |
| Version mismatch (repo vs. running) | An update was checked out but never rebuilt into the container. **The old relay is still serving.** | Section 4 below. |

---

## 3. Never do these

The relay's Docker volume holds two things that cannot be recreated:

1. **The database** — every pairing, and the relay's push identity.
2. **The TLS keypair** (`/data/tls`) — every paired phone pinned this key from its
   pairing link (ADR-0019). Regenerating it does not "fix TLS", it silently breaks
   every phone, and each one has to be paired again by hand.

So, regardless of what any generic Docker advice says:

- **Never** `docker compose down -v` or `down --volumes`.
- **Never** `docker volume rm` or `docker volume prune` on this machine.
- **Never** `docker system prune --volumes`.
- **Never** delete or move `/data/tls`, and never regenerate the certificate to fix a
  certificate warning. A certificate that no longer covers the relay's address is fixed
  by pointing clients at a covered address, or by re-pairing deliberately, not by
  minting a new one.
- **Never** delete rows from the database to clean up. Expired data is erased by the
  relay's own cleanup job.

Before any update or repair that touches the container, take a backup:

```bash
docker run --rm -v "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' tabsend-relay)":/data -v "$PWD":/backup alpine tar czf /backup/tabsend-data-$(date +%F).tar.gz /data
```

That reads the volume name off the running container on purpose. **Do not type a volume
name by hand.** Compose prefixes volumes with the project name (the checkout directory),
so the name is `tabsend_relay-data` here but different in any other checkout, and Docker
silently *creates* a named volume that does not exist rather than failing. A guessed name
therefore produces a tarball of an empty directory, exits 0, and looks like a backup.

Check the result is not empty before relying on it:

```bash
tar tzf tabsend-data-$(date +%F).tar.gz | head
```

---

## 4. Installing an update

```bash
./scripts/relay-doctor.sh                                     # 1. before
git -C . pull                                                  # 2. get the new code
docker compose -f docker-compose.lan.yml up -d --build --wait  # 3. rebuild and swap
./scripts/relay-doctor.sh                                      # 4. after
```

Notes that matter:

- `--build` is what makes it an update. Without it Compose reuses the existing image and
  nothing changes, while every command still reports success.
- `--wait` holds until the relay is actually answering. Plain `up -d` returns while it is
  still opening its listeners, so an immediate check gets a connection refusal on a
  perfectly healthy deploy.
- This **keeps** the volume. That is the whole point of using `up -d --build` rather than
  `down` and up again.
- Step 4 is not optional. If `Relay reports` still shows the old version, the rebuild did
  not take, and the running relay is not the code that was just checked out.
- If the update changes the browser extension, the extension has to be reloaded
  separately in each browser. The relay does not push client updates.

---

## 5. Reporting back

The person who runs the relay reads these reports, not the raw output. When reporting:

- Lead with the verdict: working, broken, or unknown.
- Say what to do about it, or say that nothing needs doing.
- Plain language, no jargon. He is not a developer. "The relay could not be reached" beats
  "the healthcheck returned a non-zero exit status".
- **Never report exit code 2 as healthy.** Say which checks did not run and why.
- Write in German if that is how he asked.

If you repaired something, say what you changed and whether the follow-up check passed.
If a finding needs an owner decision (`multiple_groups`, anything destructive), describe
the options and wait. Do not decide it yourself.
