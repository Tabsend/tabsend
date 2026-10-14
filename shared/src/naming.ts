import type { BrowserFamily, Platform } from './types'

/**
 * Endpoint NAMING — best-effort browser/OS guesses, and the collision rules that
 * keep a group's names distinct (dogfood pass-2 #1).
 *
 * Lives in `shared/` because all three sides need the same answers: the browser
 * clients (extension, console) to SUGGEST a name, and the relay to enforce that
 * two endpoints in one group never end up with the same label. Two
 * implementations of `uniqueBrowserName` that drifted apart would be worse than
 * none — the client would show one name and the relay would store another.
 *
 * The naming model splits into a user-named BROWSER and a device tie. Some
 * Chromium forks (Dia, Comet) masquerade as plain "Chrome" in BOTH the raw UA
 * string and `userAgentData.brands`, so no in-browser signal can separate them
 * from real Chrome. We therefore split "what to prefill" from "how sure we are":
 *
 *   - We ALWAYS prefill. An empty box makes the user invent a name cold.
 *   - `confident` says whether a signal actually NAMED this browser. When it
 *     didn't, we prefill the family we CAN see ("Chrome") and the UI says plainly
 *     that it's a guess. Right for the majority, one edit away for a fork, and
 *     the dedupe (`uniqueBrowserName`) handles two of them meeting in a group.
 *
 * Naming signals, in order of trust (see `resolveBrowserName`):
 *   1. `runtime.getBrowserInfo()` — Firefox-only API, names the REAL app, so
 *      Firefox forks (Zen, LibreWolf) stop being labelled "Firefox".
 *   2. `navigator.brave.isBrave()` / `window.opr` — engine-injected globals that
 *      some builds expose when `brands` doesn't.
 *   3. ANY non-engine brand in `userAgentData.brands`, or ANY non-engine
 *      `Name/Version` token in the UA. Deliberately open-ended rather than an
 *      allow-list: a fork that announces itself is telling the truth, so Vivaldi,
 *      Whale and next year's niche browser all work with no code change here.
 *
 * A name that survives all of that can still COLLIDE with another browser on the
 * same device — see `uniqueBrowserName`, applied at the device step.
 *
 * No hostname or profile detection (privacy).
 */

/** Minimal shape of the (non-lib.dom) UA-Client-Hints brand list. */
interface UADataBrand {
  brand: string
  version: string
}
interface NavigatorUAData {
  brands?: UADataBrand[]
}

/**
 * `navigator` as this module needs it, read off `globalThis` rather than the DOM
 * lib: the RELAY imports this file too (for the label rules) and compiles without
 * DOM types. Absent outside a browser, hence every caller's fallback.
 */
interface NavigatorLike {
  userAgent?: string
  userAgentData?: NavigatorUAData
  brave?: { isBrave: () => Promise<boolean> }
}

function currentNavigator(): NavigatorLike | undefined {
  return (globalThis as { navigator?: NavigatorLike }).navigator
}

function currentUserAgent(): string {
  return currentNavigator()?.userAgent ?? ''
}

export function detectBrowser(ua: string = currentUserAgent()): BrowserFamily {
  if (/Edg\//.test(ua)) return 'edge'
  if (/OPR\//.test(ua)) return 'opera'
  if (/Vivaldi/.test(ua)) return 'vivaldi'
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Chrome\//.test(ua)) return 'chrome'
  return 'other'
}

export function detectPlatform(ua: string = currentUserAgent()): Platform {
  if (/Macintosh|Mac OS X/.test(ua)) return 'macos'
  if (/Windows/.test(ua)) return 'windows'
  if (/Android/.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
  if (/Linux/.test(ua)) return 'linux'
  return 'unknown'
}

/** A friendly default device name from the platform, e.g. "Mac" (an editable seed). */
export function defaultDeviceName(platform: Platform): string {
  switch (platform) {
    case 'macos':
      return 'Mac'
    case 'windows':
      return 'Windows PC'
    case 'linux':
      return 'Linux PC'
    case 'android':
      return 'Android'
    case 'ios':
      return 'iPhone'
    default:
      return 'This device'
  }
}

/** Human name for a browser family, e.g. "Chrome". */
export function browserLabel(browser: BrowserFamily | null): string {
  if (!browser || browser === 'other') return 'Browser'
  return browser.charAt(0).toUpperCase() + browser.slice(1)
}

/**
 * Brand/token names that identify the ENGINE, not the browser. Everything else is
 * a real name we take at face value — that's what makes a niche fork (Vivaldi,
 * Comet, Whale, Falkon, anything shipped next year) work with no code change.
 * Plain "Google Chrome" lands here too: a bare Chromium fork (Dia) reports
 * exactly that, so it can't be treated as a name.
 */
const GENERIC_NAMES = new Set([
  'chromium',
  'google chrome',
  'chrome',
  'mozilla',
  'applewebkit',
  'khtml',
  'gecko',
  'safari',
  'version',
  'mobile',
  'like',
  'headlesschrome',
])

function isGenericName(name: string): boolean {
  return /not.*a.*brand/i.test(name) || GENERIC_NAMES.has(name.trim().toLowerCase())
}

/**
 * Tidy-ups for names that ship in a form nobody would type themselves. Only for
 * cleanup — an unlisted name is used verbatim, never dropped.
 */
const NAME_FIXUPS: Record<string, string> = {
  'microsoft edge': 'Edge',
  edg: 'Edge',
  edga: 'Edge',
  edgios: 'Edge',
  opr: 'Opera',
  crios: 'Chrome',
  fxios: 'Firefox',
  yabrowser: 'Yandex',
  samsungbrowser: 'Samsung Internet',
}

function displayName(raw: string): string {
  const name = raw.trim()
  return NAME_FIXUPS[name.toLowerCase()] ?? name
}

/**
 * The last non-engine `Name/Version` token in a UA string. Chromium forks append
 * their own token (`Vivaldi/7.0`, `OPR/120`, `Whale/4`) after the Chrome/Safari
 * boilerplate, so the LAST specific token is the browser — and a fork that
 * appends nothing simply yields undefined rather than a wrong name.
 */
function browserNameFromUaTokens(ua: string): string | undefined {
  let found: string | undefined
  for (const match of ua.matchAll(/([A-Za-z][A-Za-z .]*?)\/[\d.]+/g)) {
    const name = match[1]
    if (name && !isGenericName(name)) found = displayName(name)
  }
  return found
}

/** The name when we can't even see a family — nothing true left to say. */
export const PLACEHOLDER_BROWSER_NAME = 'My favorite browser'

export interface BrowserNameSuggestion {
  /** Pre-fill value. Always non-empty. */
  value: string
  /** True ⇒ a verified signal named this browser; false ⇒ present it AS a guess. */
  confident: boolean
}

/**
 * The UA-only half of the guess: any specific brand, then any specific UA token,
 * then the placeholder. Synchronous and pure, so it stays trivially testable;
 * `resolveBrowserName` layers the async engine probes on top.
 */
export function browserNameSuggestion(
  nav: { userAgent?: string; userAgentData?: NavigatorUAData } = currentNavigator() ?? {},
): BrowserNameSuggestion {
  // Any brand that isn't the engine is a name the browser CHOSE to publish, so
  // we trust it verbatim — no allow-list to keep up to date.
  for (const { brand } of nav.userAgentData?.brands ?? []) {
    if (!isGenericName(brand)) return { value: displayName(brand), confident: true }
  }

  // Same idea in the UA string: a fork masquerading as Chrome appends no token,
  // and Firefox's UA doesn't lie about being Firefox.
  const ua = nav.userAgent ?? ''
  const token = browserNameFromUaTokens(ua)
  if (token) return { value: token, confident: true }

  // Nothing specific (bare Chromium, "Google Chrome", Dia, Comet, Arc): use the
  // family we can see. It is right for the large majority — the ones it isn't
  // right for are running an exotic browser on purpose and will notice the hint
  // — and two of them landing in one group is a dedupe problem, not a naming one.
  const family = detectBrowser(ua)
  if (family === 'other') return { value: PLACEHOLDER_BROWSER_NAME, confident: false }
  return { value: browserLabel(family), confident: false }
}

/** The engine-injected globals and Firefox API that `browserNameSuggestion` can't see. */
export interface BrowserProbe {
  userAgent?: string
  userAgentData?: NavigatorUAData
  /** Brave answers this even in builds whose `brands` list stays silent. */
  brave?: { isBrave: () => Promise<boolean> }
  /** Opera injects `window.opr`. */
  opr?: unknown
  /** Firefox-only WebExtension API — the one API that names a browser honestly. */
  getBrowserInfo?: () => Promise<{ name?: string }>
}

function defaultProbe(): BrowserProbe {
  const nav = currentNavigator() ?? {}
  const g = globalThis as { opr?: unknown; browser?: { runtime?: { getBrowserInfo?: unknown } } }
  const getBrowserInfo = g.browser?.runtime?.getBrowserInfo
  return {
    userAgent: nav.userAgent,
    userAgentData: nav.userAgentData,
    brave: nav.brave,
    opr: g.opr,
    getBrowserInfo:
      typeof getBrowserInfo === 'function'
        ? (getBrowserInfo.bind(g.browser?.runtime) as () => Promise<{ name?: string }>)
        : undefined,
  }
}

/**
 * Suggest a browser NAME for the naming step, using every signal available —
 * async because the two most trustworthy ones (Firefox's `getBrowserInfo`,
 * Brave's `isBrave`) return promises. Never resolves to an empty value; see the
 * module header for the trust order.
 */
export async function resolveBrowserName(
  probe: BrowserProbe = defaultProbe(),
): Promise<BrowserNameSuggestion> {
  if (probe.getBrowserInfo) {
    try {
      const name = (await probe.getBrowserInfo())?.name?.trim()
      if (name) return { value: name, confident: true }
    } catch {
      // Fall through to the UA signals — a missing/refused API is not an error.
    }
  }

  if (probe.brave) {
    try {
      if (await probe.brave.isBrave()) return { value: 'Brave', confident: true }
    } catch {
      // ditto
    }
  }

  if (probe.opr) return { value: 'Opera', confident: true }

  return browserNameSuggestion(probe)
}

const LABEL_SEP = ' · '

/**
 * The endpoint display label: `${browser} · ${device}`. With no device yet
 * (the provisional label between join and the device step) it's just the
 * browser name. [ADR-0004, dogfood pass-2 #1]
 */
export function endpointLabel(browserName: string, deviceName: string): string {
  const b = browserName.trim() || 'Browser'
  const d = deviceName.trim()
  return d ? `${b}${LABEL_SEP}${d}` : b
}

/**
 * Pick a browser name that doesn't collide with one already in the group ON THE
 * SAME DEVICE — "Chrome" next to "Chrome" on one machine is unusable in the
 * chooser, and it's exactly what happens when two unidentifiable forks both fall
 * back to the same guess. Two "Chrome"s on DIFFERENT devices are fine and left
 * alone: the device half of the label already tells them apart.
 *
 * Suffixes with a plain counter ("Chrome 2"), matching case-insensitively so
 * "chrome · Mac" still counts as taken.
 */
export function uniqueBrowserName(
  browserName: string,
  deviceName: string,
  takenLabels: readonly string[],
): string {
  const taken = new Set(takenLabels.map((l) => l.trim().toLowerCase()))
  const isFree = (name: string): boolean =>
    !taken.has(endpointLabel(name, deviceName).toLowerCase())

  const base = browserName.trim()
  if (isFree(base)) return base
  // A name that already ends in a counter continues its own series ("Chrome 2"
  // → "Chrome 3") instead of becoming the absurd "Chrome 2 2".
  const m = /^(.*?)\s+(\d+)$/.exec(base)
  const stem = m ? (m[1] as string) : base
  for (let n = m ? Number(m[2]) + 1 : 2; n < 100; n++) {
    const candidate = `${stem} ${n}`
    if (isFree(candidate)) return candidate
  }
  return base
}

/**
 * Recover a device name from a label for endpoints registered before the
 * `deviceName` field existed — their label already encodes "browser · device",
 * so the existing-device suggestions can use it instead of showing nothing.
 */
export function deviceNameFromLabel(label: string): string | undefined {
  const i = label.indexOf(LABEL_SEP)
  return i === -1 ? undefined : label.slice(i + LABEL_SEP.length)
}

/**
 * The browser half of a label — the whole label when there is no device tie, so
 * it always returns a usable name. The inverse of `endpointLabel`, for reading
 * back a label the RELAY may have rewritten.
 */
export function browserNameFromLabel(label: string): string {
  const i = label.indexOf(LABEL_SEP)
  return i === -1 ? label : label.slice(0, i)
}

/**
 * The whole-label form of `uniqueBrowserName`, for callers that hold labels
 * rather than the two halves — above all the RELAY, which sees only what each
 * client registered. Splits "Chrome · MacBook" and suffixes the BROWSER half
 * ("Chrome 2 · MacBook"), because suffixing the label would produce
 * "Chrome · MacBook 2" — a claim about a second machine that doesn't exist.
 *
 * A label with no device half (a console's "Web console", a phone's "Pixel 8")
 * is treated as one name and suffixed whole.
 */
export function uniqueLabel(label: string, takenLabels: readonly string[]): string {
  const i = label.indexOf(LABEL_SEP)
  if (i === -1) return uniqueBrowserName(label, '', takenLabels)
  const browserName = label.slice(0, i)
  const deviceName = label.slice(i + LABEL_SEP.length)
  return endpointLabel(uniqueBrowserName(browserName, deviceName, takenLabels), deviceName)
}
