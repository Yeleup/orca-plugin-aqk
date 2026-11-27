// The plugin's panel in Orca's right sidebar (orca-plugin.json, contributes.panels): Orca components, no build step —
// Orca strips the types and compiles the JSX when the panel loads. The screens live in src/ui/, their texts in
// src/i18n/; the panel talks to src/worker.ts with plugin.request and hears its posts (src/protocol.ts).
import { plugin, read, settings, type PanelContext } from 'orca'
import { LANGUAGE_SETTING } from './i18n/catalog'
import { isSettingKey } from './settings'
import { ConnectScreen } from './ui/connect'
import { language, loadLanguage } from './ui/language'
import { route } from './ui/navigation'
import { connectedProjects, QueueScreen } from './ui/queue'
import { ScreenFrame } from './ui/screens'
import { pluginSettings, refreshSettings, SettingsScreen } from './ui/settings'
import { BlankRows } from './ui/states'

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    // A setting changed — on the screen «Настройки», in Orca's Settings or by the worker.
    settings.onDidChange(({ key }) => {
      if (key === LANGUAGE_SETTING) void loadLanguage()
      if (isSettingKey(key)) void refreshSettings()
    }),
    plugin.on('projects.changed', ({ projects }) => connectedProjects.resolve(projects)),
  )
  void loadLanguage()
  void pluginSettings.load()
  void connectedProjects.load()
}

export default function Panel() {
  // Until the language is read nothing can be named from the catalogs: unnamed placeholder rows.
  if (read(language) === null) return <BlankRows />
  const { screen } = read(route)
  if (screen === 'queue') return <QueueScreen />
  if (screen === 'settings') return <SettingsScreen />
  if (screen === 'connect') return <ConnectScreen />
  return <ScreenFrame screen={screen} />
}
