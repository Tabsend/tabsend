import './styles.css'
import { Controller } from './lib/controller'
import { mountApp } from './ui/app'

/**
 * Console bootstrap. Builds the controller (real localStorage + IndexedDB + fetch +
 * WebSocket), mounts the UI, and loads any stored session. If none, onboarding shows.
 */
const root = document.getElementById('app')
if (root) {
  const controller = new Controller()
  mountApp(root, controller)
  void controller.init()
  window.addEventListener('beforeunload', () => controller.teardown())
}
