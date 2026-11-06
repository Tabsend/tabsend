import { resolve } from 'node:path'
import { defaultDeviceName, type Platform } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import { languageMessages } from '../../../shared/tools/i18n-catalog'
import { languageMessages as consoleMessages } from '../../tools/i18n-vite'
import { t } from './i18n'

/**
 * Sentences the console and the browser extension must say with the same words (docs/L10N.md
 * glossary: the reset, the history states, the new-device warning, the relative times, the
 * buttons both have). Each line is `[console key, extension key]`; the English must be
 * identical, placeholders included. They are two catalogs, not one, so each surface can be
 * translated on its own; this test is what keeps them from drifting apart. If a pair should
 * stop matching on purpose, take it out of the list and say why in the commit.
 *
 * When a language is added, a translator can use these pairs to translate each sentence once.
 */
const PAIRS: [console: string, extension: string][] = [
  // The reset that waits
  ['devices.reset.title', 'devices.reset.title'],
  ['devices.reset.body', 'devices.reset.body'],
  ['devices.reset.stop', 'devices.reset.stop'],
  ['devices.reset.dismiss', 'devices.reset.dismiss'],
  ['devices.reset.stopped', 'devices.reset.stopped'],
  ['devices.reset.stopFailedOffline', 'devices.reset.stopFailedOffline'],
  // A device that joined, then disappeared
  ['devices.vanished.title', 'devices.vanished.title'],
  ['devices.vanished.body', 'devices.vanished.body'],
  // History
  ['history.state.arrived', 'history.state.arrived'],
  ['history.state.waiting', 'history.state.waiting'],
  ['history.state.neverArrived', 'history.state.neverArrived'],
  ['history.batch.heading', 'history.batch.heading'],
  ['history.batch.partial', 'history.batch.partial'],
  ['history.unknownDevice', 'history.unknownDevice'],
  ['history.sealed.title', 'history.row.waitingForKey'],
  ['history.title', 'common.history'],
  ['app.tab.history', 'common.history'],
  // Devices
  ['devices.add', 'common.addDevice'],
  ['pairing.title', 'common.addDevice'],
  ['devices.kind.browser', 'devices.kind.browser'],
  ['devices.kind.phone', 'devices.kind.phone'],
  ['devices.tag.inactive', 'presence.inactive'],
  ['devices.lastSeen.ago', 'presence.lastSeen'],
  // Pairing
  ['onboarding.setupLink.label', 'pairing.box.linkLabel'],
  ['pairing.qr.label', 'pairing.box.qrLabel'],
  ['common.copyLink', 'pairing.box.copyLink'],
  ['pairing.error.invalidLink', 'errors.setupLink.invalid'],
  ['pairing.error.invalidQrLink', 'errors.setupLink.invalidQr'],
  ['pairing.error.invalidQrRoute', 'errors.setupLink.invalidQrRoute'],
  // What a relay refusal says (the same code, the same situation, the same words)
  ['status.relay.forbidden', 'errors.relay.forbidden'],
  ['status.relay.deviceNotFound', 'errors.relay.deviceNotFound'],
  ['status.relay.addressNotRelay', 'errors.relay.addressNotRelay'],
  ['status.relay.linkUnusable', 'errors.relay.linkUnusable'],
  ['status.relay.linkInvalid', 'send.failure.error.invalidPairingCode'],
  ['status.relay.groupExists', 'send.failure.error.groupExists'],
  ['status.relay.deviceLimit', 'send.failure.deviceLimit'],
  ['status.relay.linkLimit', 'errors.relay.linkLimit'],
  ['status.relay.limit', 'errors.relay.limit'],
  ['status.relay.busy', 'errors.relay.busy'],
  ['status.relay.unexplained', 'send.failure.unexplained'],
  // Small words and times
  ['app.loading', 'common.loading'],
  ['common.cancel', 'common.cancel'],
  ['common.dismiss', 'common.dismiss'],
  ['common.rename', 'common.rename'],
  ['common.remove', 'common.remove'],
  ['status.requestFailedHttp', 'errors.api.requestFailed'],
  ['time.justNow', 'common.time.ago.now'],
  ['time.minutes', 'common.time.ago.minutes'],
  ['time.hours', 'common.time.ago.hours'],
  ['time.days', 'common.time.ago.days'],
  ['time.months', 'history.time.months'],
  ['time.years', 'history.time.years'],
  ['time.unknown', 'history.time.unknown'],
  ['time.recently', 'common.time.ago.recently'],
]

const EXTENSION_LOCALES = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'extension',
  'src',
  'locales',
)

describe('the console and the browser extension say the same thing', () => {
  const ours = consoleMessages('en')
  const theirs = languageMessages(EXTENSION_LOCALES, 'en')

  it('uses keys that exist on both sides', () => {
    const missing = PAIRS.flatMap(([mine, other]) => [
      ...(mine in ours ? [] : [`console: "${mine}"`]),
      ...(other in theirs ? [] : [`extension: "${other}"`]),
    ])
    expect(missing).toEqual([])
  })

  it('in English, word for word', () => {
    const different = PAIRS.filter(([mine, other]) => ours[mine] !== theirs[other]).map(
      ([mine, other]) =>
        `${mine}\n    console:   ${ours[mine]}\n    extension: ${theirs[other]} (${other})`,
    )
    expect(different).toEqual([])
  })
})

describe('the name suggested for this device', () => {
  // The shared module (the relay and the other apps use it) keeps its English default; the
  // console words the same thing from its catalog so a language can change it (docs/L10N.md
  // rule 12). In English the two must be identical.
  const platforms: Platform[] = ['macos', 'windows', 'linux', 'android', 'ios', 'unknown']
  for (const platform of platforms) {
    it(`is "${defaultDeviceName(platform)}" for ${platform}, as in the shared default`, () => {
      expect(t('onboarding.name.deviceSeed', { platform })).toBe(defaultDeviceName(platform))
    })
  }
})
