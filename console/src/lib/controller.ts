import {
  type CreatePairingResponse,
  confirmNewDevice,
  confirmReview,
  dismissVanished,
  type Endpoint,
  endpointsKnownTo,
  type GroupKeyRecord,
  type GroupResetState,
  ListWithoutSelfError,
  listIncludesSelf,
  type NewDeviceNotice,
  type NewDeviceWatch,
  type PairingCodeValue,
  type Platform,
  type PushSubscription,
  parseVouch,
  removeDevice,
  type ServerStreamEvent,
  settleNotices,
  vouchTags,
  watchDevices,
  withVouch,
} from '@tabsend/shared'
import {
  ApiClientError,
  type ApiOptions,
  ackMessage,
  deleteEndpoint,
  type FetchLike,
  getConfig,
  getGroupHistory,
  getGroupKeys,
  getGroupState,
  getPending,
  isMissingRouteError,
  listEndpoints,
  mintPairing,
  register,
  renameEndpoint,
  stopGroupReset,
} from './api'
import { generateKeyPair, keyId } from './crypto'
import { syncGroupKeys } from './group-keys'
import { changedRows, mergeTimeline, projectGroupHistory } from './history'
import { sortKeys } from './keyring'
import type { ConnectionMode, ConsoleSession, HistoryEntry } from './model'
import {
  isLoopbackRelayUrl,
  pairingLinkRelayUrl,
  parsePairingInput,
  protocolMismatchMessage,
} from './pairing'
import { defaultHistoryStore, type HistoryStore } from './persist'
import { consumePending, sortHistory } from './receive'
import {
  clearPairingVouch,
  clearSession,
  defaultKv,
  type KeyValue,
  loadDismissedGroupReset,
  loadKeyring,
  loadNewDeviceWatch,
  loadPairingVouch,
  loadSession,
  saveDismissedGroupReset,
  saveKeyring,
  saveNewDeviceWatch,
  savePairingVouch,
  saveSession,
} from './session'
import { type Signal, signal } from './store'
import { StreamClient } from './stream'
import { groupResetCopy } from './view'

export type Phase = 'loading' | 'onboarding' | 'ready'

export interface StatusLine {
  kind: 'idle' | 'info' | 'error'
  message: string
}

export interface PairingView {
  relayUrl: string
  link: string
  qrLink: string
  expiresAt: string
  routeNote?: string
  /**
   * true when `relayUrl` is loopback, so the link can only ever work for another
   * client on this same machine — never a phone. Surfaced beside the QR, because
   * otherwise the dead end is only discovered on the scanning device.
   */
  localOnly: boolean
}

/** Injectable seams so the controller is testable without a browser. */
export interface ControllerDeps {
  kv: KeyValue
  store: HistoryStore
  fetchImpl: FetchLike
  WebSocketImpl?: (new (url: string) => WebSocket) | undefined
  now: () => number
  /** Same-origin relay base by default (''); a link may pin a different origin. */
  detectPlatform: () => Platform
}

const POLL_INTERVAL_MS = 20_000 // < the 90s presence window; keeps the console "online"

/**
 * How long to leave group history alone after a relay says it has no such route.
 *
 * A relay predating ADR-0028 refuses both calls (400 on `?history=1`, 404 on
 * `/v1/group-keys`). Asking again every 20 seconds forever would be two pointless
 * requests per poll for the lifetime of the tab. Asking again eventually matters
 * just as much: this console is usually served BY that relay, so the realistic
 * sequence is that the operator upgrades it under a tab that has been open for
 * days, and a console that gave up permanently would never notice.
 */
const GROUP_HISTORY_RETRY_MS = 10 * 60_000

/**
 * Whether this relay serves group history [ADR-0028]. 'unknown' until the first
 * answer, so the panel does not accuse a relay of being old before it has asked.
 */
export type GroupHistoryStatus = 'unknown' | 'ready' | 'unavailable'

/** A console has no push channel — it pulls in an open tab (chunk-4 note). A .invalid
 *  endpoint satisfies the required shape and can never be woken (DNS-guaranteed fail). */
const NO_PUSH_SUBSCRIPTION: PushSubscription = {
  transport: 'unifiedpush',
  endpoint: 'https://push.invalid/console-has-no-push',
}

export class Controller {
  readonly phase: Signal<Phase> = signal<Phase>('loading')
  readonly session: Signal<ConsoleSession | null> = signal<ConsoleSession | null>(null)
  readonly endpoints: Signal<Endpoint[]> = signal<Endpoint[]>([])
  /**
   * Joined devices this console has not answered yet (PLANS.md P-10). The
   * console has no background, so this banner is its whole notice.
   */
  readonly newDevices: Signal<NewDeviceNotice[]> = signal<NewDeviceNotice[]>([])
  /** The first look: the other devices in the first list, waiting for one answer (GH6). */
  readonly review: Signal<NewDeviceNotice[]> = signal<NewDeviceNotice[]>([])
  /** Announced as new, never answered, then gone from the list (GH7). */
  readonly vanished: Signal<NewDeviceNotice[]> = signal<NewDeviceNotice[]>([])
  /**
   * A reset waiting to replace the group (PLANS.md P-18 item 12), unless this
   * console answered "It was me" to it. The console has no background, so this
   * card is its whole notice.
   */
  readonly groupReset: Signal<GroupResetState | null> = signal<GroupResetState | null>(null)
  readonly history: Signal<HistoryEntry[]> = signal<HistoryEntry[]>([])
  /** The group history keyring [ADR-0028]. Rendered only as a count, in Account. */
  readonly keyring: Signal<GroupKeyRecord[]> = signal<GroupKeyRecord[]>([])
  readonly groupHistory: Signal<GroupHistoryStatus> = signal<GroupHistoryStatus>('unknown')
  /**
   * The relay serves group history but no key has reached this console yet, so
   * every row is unreadable. A real state with a real resolution (another paired
   * device delivers one), and the panel says so rather than showing a wall of
   * rows with no content and no explanation.
   */
  readonly awaitingGroupKey: Signal<boolean> = signal<boolean>(false)
  readonly connection: Signal<ConnectionMode> = signal<ConnectionMode>('offline')
  readonly pushEnabled: Signal<boolean> = signal<boolean>(false)
  readonly status: Signal<StatusLine> = signal<StatusLine>({ kind: 'idle', message: '' })
  readonly pairing: Signal<PairingView | null> = signal<PairingView | null>(null)
  readonly busy: Signal<boolean> = signal<boolean>(false)

  private stream: StreamClient | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  /** Epoch ms before which group history is not worth asking about again. */
  private groupHistoryRetryAt = 0
  /** The reset the relay last reported, before this console's own answer is applied. */
  private pendingReset: GroupResetState | null = null
  /** `requestedAt` of a reset this console stopped, so a read already in flight cannot bring it back. */
  private stoppedReset: string | undefined

  private readonly deps: ControllerDeps

  constructor(deps?: Partial<ControllerDeps>) {
    this.deps = {
      kv: deps?.kv ?? defaultKv(),
      store: deps?.store ?? defaultHistoryStore(),
      fetchImpl: deps?.fetchImpl ?? ((...args) => fetch(...args)),
      WebSocketImpl: deps?.WebSocketImpl,
      now: deps?.now ?? Date.now,
      detectPlatform: deps?.detectPlatform ?? detectPlatform,
    }
  }

  /** API options bound to the current session's relay base (same-origin default). */
  private opts(relayUrl?: string): ApiOptions {
    return {
      relayUrl: relayUrl ?? this.session.get()?.relayUrl ?? '',
      fetchImpl: this.deps.fetchImpl,
    }
  }

  // -- lifecycle ------------------------------------------------------------

  /** Load a stored session and, if paired, go live. Otherwise show onboarding. */
  async init(): Promise<void> {
    const stored = loadSession(this.deps.kv)
    if (!stored) {
      this.phase.set('onboarding')
      return
    }
    this.session.set(stored)
    this.keyring.set(loadKeyring(this.deps.kv))
    this.showWatch(loadNewDeviceWatch(this.deps.kv), stored)
    // Render the cache first, then go to the relay: the panel is useful offline
    // and should not wait on a network round trip to show what it already has.
    await this.reloadTimeline()
    this.phase.set('ready')
    await this.refreshConfig()
    await this.refresh()
    this.goLive()
  }

  /** Stop all background loops (page unload / unpair). */
  teardown(): void {
    this.stream?.stop()
    this.stream = null
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  // -- pairing IN (this console joins a group) ------------------------------

  /**
   * Join a group as a kind:'console' endpoint. Generates an X25519 keypair, registers
   * with the secret inside the pairing link, stores the token + keys, then goes live.
   */
  async join(rawInput: string, label: string): Promise<void> {
    const parsed = parsePairingInput(rawInput)
    if (!parsed) {
      this.status.set({ kind: 'error', message: 'Enter a complete setup link.' })
      return
    }
    const relayUrl = parsed.relayUrl
    const deviceName = label.trim() === '' ? 'Web console' : label.trim()

    this.busy.set(true)
    this.status.set({ kind: 'info', message: 'Pairing…' })
    try {
      // First-run pairing needs a relay that creates the bootstrap group and
      // code at startup. Check before register so an older, reachable relay is
      // named as stale instead of producing a vague pairing failure.
      const protocolError = protocolMismatchMessage(await getConfig(this.opts(relayUrl)))
      if (protocolError) throw new Error(protocolError)
      const kp = await generateKeyPair()
      const kid = await keyId(kp.publicKey)
      const res = await register(this.opts(relayUrl), {
        label: deviceName,
        kind: 'console',
        browser: null, // a console isn't a send target; don't guess a browser (DOGFOOD #1)
        platform: this.deps.detectPlatform(),
        pushSubscription: NO_PUSH_SUBSCRIPTION,
        e2ePubkey: kp.publicKey,
        pairingCode: parsed.code as PairingCodeValue,
      })
      // The devices the pairing link vouched for go on no first look (P-23). Kept
      // until the first list of this pairing is judged, so a reload does not lose them.
      const vouched = parseVouch(rawInput)
      if (vouched) savePairingVouch({ endpointId: res.endpointId, tags: vouched }, this.deps.kv)
      const session: ConsoleSession = {
        relayUrl,
        endpointId: res.endpointId,
        groupId: res.groupId,
        deviceToken: res.deviceToken,
        // The relay de-duplicates labels within a group, so it may have stored
        // something other than what we sent ("Web console 2"). Mirror its answer.
        label: res.label ?? deviceName,
        publicKey: kp.publicKey,
        privateKey: kp.privateKey,
        keyId: kid,
      }
      saveSession(session, this.deps.kv)
      this.session.set(session)
      this.phase.set('ready')
      this.status.set({ kind: 'idle', message: '' })
      await this.refreshConfig()
      await this.refresh()
      this.goLive()
    } catch (err) {
      this.status.set({ kind: 'error', message: joinError(err, relayUrl) })
    } finally {
      this.busy.set(false)
    }
  }

  /** Forget this console's pairing locally. Does NOT remove the endpoint server-side —
   *  do that from the devices panel (it names the consequence). */
  unpair(): void {
    this.teardown()
    clearSession(this.deps.kv) // clears the device token, the keypair AND the keyring
    void this.deps.store.clear()
    this.session.set(null)
    this.endpoints.set([])
    this.newDevices.set([])
    this.review.set([])
    this.vanished.set([])
    this.groupReset.set(null)
    this.pendingReset = null
    this.stoppedReset = undefined
    this.history.set([])
    this.keyring.set([])
    this.awaitingGroupKey.set(false)
    this.groupHistory.set('unknown')
    this.groupHistoryRetryAt = 0
    this.connection.set('offline')
    this.phase.set('onboarding')
  }

  // -- device management ----------------------------------------------------

  async refresh(): Promise<void> {
    const session = this.session.get()
    if (!session) return
    let list: Endpoint[]
    try {
      list = await this.fetchWatchedEndpoints(session)
    } catch (err) {
      // A list without this console is treated as a failed fetch, but it is not
      // an outage: keep the last good list and say nothing.
      if (!(err instanceof ListWithoutSelfError)) this.connection.set('offline')
      return
    }
    await this.refreshGroupReset()
    try {
      if (this.connection.get() === 'offline') this.connection.set('polling')
      // Group history first: it is the authoritative list [ADR-0028]. The
      // ADR-0010 copy drain still runs, both because an older sender is still
      // making copies and because an unacked copy sits at the relay until it
      // expires if nobody drains it.
      await this.syncGroupHistory(list)
      await this.consume(list)
    } catch {
      this.connection.set('offline')
    }
  }

  /**
   * The only way this console fetches the device list. Every list it acts on,
   * including the re-fetch a key copy from an unknown sender triggers, goes
   * through the new-device watch first, and a list without this console is
   * refused: the watch ignores such a list, so nothing else may use it (review
   * 2026-10-13; before, the key sync's re-fetch skipped the watch entirely and
   * a relay could trigger it at will).
   */
  private async fetchWatchedEndpoints(session: ConsoleSession): Promise<Endpoint[]> {
    const list = await listEndpoints(this.opts(), session.deviceToken)
    if (!listIncludesSelf(list, session.endpointId)) throw new ListWithoutSelfError()
    this.watchNewDevices(list, session)
    this.endpoints.set(list)
    return list
  }

  /**
   * Compare every fetched list with the last one (PLANS.md P-10). Every fetch,
   * not the `endpoint_added` event: a relay that wanted to hide a device would
   * not send that event.
   */
  private watchNewDevices(list: Endpoint[], session: ConsoleSession): void {
    // The console never rotates, but the record keeps the same shape everywhere. Its
    // debt just sits: a device that can mint settles it.
    const prev = loadNewDeviceWatch(this.deps.kv)
    const vouch = prev?.selfId === session.endpointId ? null : loadPairingVouch(this.deps.kv)
    const vouched = vouch?.endpointId === session.endpointId ? vouch.tags : undefined
    const { watch } = watchDevices(
      prev,
      list,
      session.endpointId,
      new Date(this.deps.now()).toISOString(),
      sortKeys(this.keyring.get())[0]?.createdAt,
      undefined,
      vouched,
    )
    if (!watch) return
    // Told once, as information, by a phone or a browser (P-23); a console has no
    // notifications and keeps nothing waiting for an answer.
    const settled = settleNotices(watch)
    saveNewDeviceWatch(settled, this.deps.kv)
    if (vouched && watch.selfId === session.endpointId) clearPairingVouch(this.deps.kv)
    this.showWatch(settled, session)
  }

  /** Put what the watch asks this console to look at on screen, for this pairing only. */
  private showWatch(watch: NewDeviceWatch | null, session: ConsoleSession): void {
    const mine = watch && watch.selfId === session.endpointId ? watch : null
    this.newDevices.set(mine?.unconfirmed ?? [])
    this.review.set(mine?.review ?? [])
    this.vanished.set(mine?.vanished ?? [])
  }

  /**
   * This console removed `id` and the relay accepted the request: write it into
   * the watch now. "Remove" is only a request, and a relay that answers it and keeps
   * listing the device would otherwise trigger no departure (X13). The console never
   * rotates the key itself, but it does stop trusting key copies from the device,
   * and announces it if the list shows it again.
   */
  private recordRemoval(id: string, session: ConsoleSession): void {
    const watch = loadNewDeviceWatch(this.deps.kv)
    if (!watch || watch.selfId !== session.endpointId) return
    const next = removeDevice(
      watch,
      id,
      new Date(this.deps.now()).toISOString(),
      sortKeys(this.keyring.get())[0]?.createdAt,
    )
    saveNewDeviceWatch(next, this.deps.kv)
    this.showWatch(next, session)
  }

  /** Only the devices the watch has accepted may vouch for a key copy (never one this console removed). */
  private trusted(list: Endpoint[]): Endpoint[] {
    return endpointsKnownTo(loadNewDeviceWatch(this.deps.kv), list)
  }

  /** "It's mine": this console's New tag on that device goes; other devices answer for themselves. */
  confirmNewDevice(id: string): void {
    const watch = loadNewDeviceWatch(this.deps.kv)
    if (!watch) return
    const next = confirmNewDevice(watch, id)
    saveNewDeviceWatch(next, this.deps.kv)
    this.newDevices.set(next.unconfirmed)
    this.review.set(next.review ?? [])
  }

  /** "All of these are mine": the first look is answered on this console only. */
  confirmReview(): void {
    const watch = loadNewDeviceWatch(this.deps.kv)
    if (!watch) return
    saveNewDeviceWatch(confirmReview(watch), this.deps.kv)
    this.review.set([])
  }

  /** Dismiss one "joined, then disappeared" notice on this console. */
  dismissVanished(id: string): void {
    const watch = loadNewDeviceWatch(this.deps.kv)
    if (!watch) return
    const next = dismissVanished(watch, id)
    saveNewDeviceWatch(next, this.deps.kv)
    this.vanished.set(next.vanished ?? [])
  }

  // -- the reset that waits (PLANS.md P-18 item 12) --------------------------

  /**
   * Ask the relay whether a reset is waiting. Runs with every refresh (the poll) and
   * on `group_updated`. An older relay answers 404, read as "none", quietly; any
   * other failure keeps what was shown, since the next poll asks again.
   */
  async refreshGroupReset(): Promise<void> {
    const session = this.session.get()
    if (!session) return
    let reset: GroupResetState | null
    try {
      reset = (await getGroupState(this.opts(), session.deviceToken)).reset ?? null
    } catch (err) {
      if (!(err instanceof ApiClientError && err.status === 404)) return
      reset = null
    }
    if (reset && reset.requestedAt === this.stoppedReset) reset = null
    this.pendingReset = reset
    this.showGroupReset(session)
  }

  private showGroupReset(session: ConsoleSession): void {
    const reset = this.pendingReset
    const dismissed = loadDismissedGroupReset(session.endpointId, this.deps.kv)
    this.groupReset.set(reset && reset.requestedAt !== dismissed ? reset : null)
  }

  /**
   * "Stop the reset". On success the card goes and the status line says so; on
   * failure the card stays and the status line says why.
   */
  async stopGroupReset(): Promise<void> {
    const session = this.session.get()
    if (!session) return
    const stopping = this.pendingReset
    this.busy.set(true)
    try {
      await stopGroupReset(this.opts(), session.deviceToken)
      if (stopping) this.stoppedReset = stopping.requestedAt
      this.pendingReset = null
      this.showGroupReset(session)
      this.status.set({ kind: 'info', message: groupResetCopy.stopped })
    } catch (err) {
      const message =
        err instanceof TypeError
          ? groupResetCopy.stopFailedOffline
          : groupResetCopy.stopFailed(describe(err, 'Request failed.'))
      this.status.set({ kind: 'error', message })
    } finally {
      this.busy.set(false)
    }
  }

  /** "It was me": hide this request only, on this console. A new request shows again. */
  dismissGroupReset(): void {
    const session = this.session.get()
    const reset = this.pendingReset
    if (!session || !reset) return
    saveDismissedGroupReset(session.endpointId, reset.requestedAt, this.deps.kv)
    this.showGroupReset(session)
  }

  private async refreshConfig(): Promise<void> {
    try {
      const cfg = await getConfig(this.opts())
      this.pushEnabled.set(cfg.vapidPublicKey !== '')
    } catch {
      this.pushEnabled.set(false)
    }
  }

  async rename(id: string, label: string): Promise<void> {
    const session = this.session.get()
    if (!session) return
    this.busy.set(true)
    try {
      await renameEndpoint(this.opts(), session.deviceToken, id, label)
      // Keep our own label in sync if we renamed ourselves.
      if (id === session.endpointId) {
        const updated = { ...session, label }
        saveSession(updated, this.deps.kv)
        this.session.set(updated)
      }
      await this.refresh()
      this.status.set({ kind: 'idle', message: '' })
    } catch (err) {
      this.status.set({ kind: 'error', message: describe(err, 'Rename failed.') })
    } finally {
      this.busy.set(false)
    }
  }

  async remove(id: string): Promise<void> {
    const session = this.session.get()
    if (!session) return
    this.busy.set(true)
    try {
      try {
        await deleteEndpoint(this.opts(), session.deviceToken, id)
      } catch (err) {
        // "Not found" means it is already gone, which is what was asked for: the
        // same reading the phones and the extension take.
        if (!(err instanceof ApiClientError && err.status === 404)) throw err
      }
      // Removing our own console endpoint invalidates this session.
      if (id === session.endpointId) {
        this.unpair()
        this.status.set({ kind: 'info', message: 'This console was removed from the group.' })
        return
      }
      this.recordRemoval(id, session)
      await this.refresh()
      this.status.set({ kind: 'idle', message: '' })
    } catch (err) {
      this.status.set({ kind: 'error', message: describe(err, 'Remove failed.') })
    } finally {
      this.busy.set(false)
    }
  }

  /** Mint a short-lived pairing link + QR (the "add a device" surface). */
  async addDevice(): Promise<void> {
    const session = this.session.get()
    if (!session) return
    this.busy.set(true)
    try {
      const res: CreatePairingResponse = await mintPairing(this.opts(), session.deviceToken)
      // The devices this console has accepted ride along, so the new device asks only
      // about the ones that do not match (P-23). The relay never sees the fragment.
      const tags = vouchTags(
        loadNewDeviceWatch(this.deps.kv),
        this.endpoints.get(),
        session.endpointId,
      )
      const copyLink = withVouch(res.browserLink ?? res.link, tags)
      const parsed = parsePairingInput(copyLink)
      if (!parsed) throw new Error('The relay returned an invalid setup link.')
      const qrLink = withVouch(res.link, tags)
      const qrParsed = parsePairingInput(qrLink)
      if (!qrParsed) throw new Error('The relay returned an invalid QR setup link.')
      const qrRelayUrl = pairingLinkRelayUrl(qrLink)
      if (!qrRelayUrl) throw new Error('The relay returned an invalid QR pairing route.')
      this.pairing.set({
        relayUrl: parsed.relayUrl,
        link: copyLink,
        qrLink,
        expiresAt: res.expiresAt,
        ...(parsed.relayUrl !== qrRelayUrl
          ? {
              routeNote: `The copied link pairs browser extensions through ${parsed.relayUrl}. The QR pairs phones through ${qrRelayUrl}. Each device saves its route to this same relay; it can be changed later in its connection settings.`,
            }
          : {}),
        // The relay names its own address; an unconfigured dev relay names a
        // loopback one, and only the minting surface can say so in time.
        localOnly: isLoopbackRelayUrl(qrRelayUrl),
      })
    } catch (err) {
      this.status.set({ kind: 'error', message: describe(err, 'Could not make a setup link.') })
    } finally {
      this.busy.set(false)
    }
  }

  dismissPairing(): void {
    this.pairing.set(null)
  }

  // -- history --------------------------------------------------------------

  /**
   * Collect group keys, read the group's history, and cache it locally [ADR-0028].
   *
   * Never throws. A relay that predates ADR-0028 is a state, not a failure: it
   * answers 400 on `?history=1` and 404 on `/v1/group-keys`, which marks the
   * feature unavailable, backs the probe off, and leaves the panel running on the
   * ADR-0010 copies it used to run on entirely. Anything else (an outage, a 5xx)
   * is left alone so a blip cannot switch the console into fallback for good.
   */
  private async syncGroupHistory(endpoints: Endpoint[]): Promise<void> {
    const session = this.session.get()
    if (!session) return
    const now = this.deps.now()
    if (this.groupHistory.get() === 'unavailable' && now < this.groupHistoryRetryAt) return

    const opts = this.opts()
    try {
      const keys = await syncGroupKeys({
        sources: {
          listEndpoints: async () => this.trusted(await this.fetchWatchedEndpoints(session)),
          getGroupKeys: () => getGroupKeys(opts, session.deviceToken),
        },
        session,
        ring: this.keyring.get(),
        endpoints: this.trusted(endpoints),
      })
      if (keys.added > 0) {
        saveKeyring(keys.ring, this.deps.kv)
        this.keyring.set(keys.ring)
      }
      this.awaitingGroupKey.set(keys.awaitingFirstKey)

      const rows = await getGroupHistory(opts, session.deviceToken)
      this.groupHistory.set('ready')

      const projected = await projectGroupHistory(rows, keys.ring, endpoints, this.deps.now())
      const cached = await this.deps.store.list()
      const writes = changedRows(cached, projected)
      for (const entry of writes) await this.deps.store.put(entry)
      if (writes.length > 0) await this.reloadTimeline()
    } catch (err) {
      if (isMissingRouteError(err)) {
        this.groupHistory.set('unavailable')
        this.groupHistoryRetryAt = now + GROUP_HISTORY_RETRY_MS
      }
      // Everything else: stay as we are and let the next poll try again.
    }
  }

  /** Pull + record any pending ADR-0010 copies, then refresh the rendered list. */
  async consume(endpoints?: Endpoint[]): Promise<void> {
    const session = this.session.get()
    if (!session) return
    const opts = this.opts()
    const summary = await consumePending({
      sources: {
        listEndpoints: () =>
          endpoints ? Promise.resolve(endpoints) : this.fetchWatchedEndpoints(session),
        getPending: () => getPending(opts, session.deviceToken),
        ack: (id) => ackMessage(opts, session.deviceToken, id).then(() => undefined),
      },
      session,
      store: this.deps.store,
      now: this.deps.now,
    })
    if (summary.recorded > 0) await this.reloadTimeline()
  }

  /**
   * Rebuild the rendered list from the local cache. `mergeTimeline` is what keeps
   * a send from appearing twice when an older sender wrote both a group blob and
   * a copy addressed to this console.
   */
  private async reloadTimeline(): Promise<void> {
    this.history.set(sortHistory(mergeTimeline(await this.deps.store.list())))
  }

  /**
   * Empty this browser's cache. Group history rows come back from the relay on
   * the next refresh, because the relay owns that list now; ADR-0010 copies do
   * not, because this console is the only place they ever existed. The button's
   * copy says exactly that.
   */
  async clearHistory(): Promise<void> {
    await this.deps.store.clear()
    this.history.set([])
  }

  // -- live path (WS fast path + poll correctness path) ---------------------

  private goLive(): void {
    const session = this.session.get()
    if (!session) return
    this.startPolling()
    this.startStream(session)
  }

  private startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.refresh()
    }, POLL_INTERVAL_MS)
  }

  private startStream(session: ConsoleSession): void {
    this.stream?.stop()
    const handlers = {
      onEvent: (event: ServerStreamEvent) => this.onStreamEvent(event),
      onOpen: () => this.connection.set('live'),
      onClose: () => {
        // Degrade to polling; the poll loop is the correctness path (ADR-0001).
        if (this.connection.get() === 'live') this.connection.set('polling')
      },
    }
    this.stream = this.deps.WebSocketImpl
      ? new StreamClient(session.relayUrl, session.deviceToken, handlers, this.deps.WebSocketImpl)
      : typeof WebSocket !== 'undefined'
        ? new StreamClient(session.relayUrl, session.deviceToken, handlers)
        : null
    this.stream?.start()
  }

  private onStreamEvent(event: ServerStreamEvent): void {
    switch (event.type) {
      case 'message':
        // A copy is available — pull + record it (envelope opening happens locally).
        void this.consume()
        break
      case 'presence':
      case 'endpoint_added':
      case 'endpoint_removed':
      case 'endpoint_updated':
        void this.refresh()
        break
      case 'group_updated':
        // A reset was scheduled or stopped. The event carries nothing; read again.
        void this.refreshGroupReset()
        break
      default:
        // 'acked'/'pong' — the console isn't a real-send source, so 'acked' won't
        // arrive for it; ignore both.
        break
    }
  }
}

// -- helpers ----------------------------------------------------------------

/** Best-effort platform for the register label. Never throws; defaults to unknown. */
export function detectPlatform(): Platform {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  const uaData = (nav as { userAgentData?: { platform?: string } } | undefined)?.userAgentData
  const raw = (uaData?.platform ?? nav?.platform ?? nav?.userAgent ?? '').toLowerCase()
  if (raw.includes('mac')) return 'macos'
  if (raw.includes('win')) return 'windows'
  if (raw.includes('android')) return 'android'
  if (raw.includes('iphone') || raw.includes('ipad') || raw.includes('ios')) return 'ios'
  if (raw.includes('linux')) return 'linux'
  return 'unknown'
}

function describe(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  return fallback
}

function joinError(err: unknown, relayUrl: string): string {
  // A raw fetch rejection (TypeError) means the relay was unreachable.
  if (err instanceof TypeError) {
    const where = relayUrl === '' ? 'this relay' : relayUrl
    return `Couldn't reach ${where}. Is the relay running and reachable?`
  }
  if (err instanceof Error && err.message) return err.message
  return 'Pairing failed.'
}
