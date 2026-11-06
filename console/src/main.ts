import './styles.css'
import { Controller } from './lib/controller'
import { getLocale, t } from './lib/i18n'
import { mountApp } from './ui/app'

/**
 * The page's own words, in the visitor's language. The built HTML already holds the English
 * title, description and no-script text (the build fills them in from the catalog, so the page
 * is complete before any script runs); this sets the language the person reads in.
 */
function localizeHead(): void {
  document.documentElement.setAttribute('lang', getLocale())
  document.title = t('meta.title')
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('meta.description'))
}

/**
 * Console bootstrap. Builds the controller (real localStorage + IndexedDB + fetch +
 * WebSocket), mounts the UI, and loads any stored session. If none, onboarding shows.
 */
const root = document.getElementById('app')
if (root) {
  localizeHead()
  const controller = new Controller()
  mountApp(root, controller)
  void controller.init()
  window.addEventListener('beforeunload', () => controller.teardown())
}
