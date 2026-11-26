// The plugin's seven labels (TZ «Данные»): a task in the queue, in work, waiting for the owner, given to splitting; the
// «MVP» issue, its autopilot; the pause of the project's queue. Connecting a project creates the missing ones.
import type { GitHubLanguage } from './check'

export const PLUGIN_LABELS = [
  'agent-queue',
  'agent-queue:working',
  'agent-queue:blocked',
  'agent-queue:split',
  'agent-queue:mvp',
  'agent-queue:autopilot',
  'agent-queue:paused',
] as const

export type PluginLabel = (typeof PLUGIN_LABELS)[number]

export function isPluginLabel(name: string): name is PluginLabel {
  return (PLUGIN_LABELS as readonly string[]).includes(name)
}

// The colour (hex, without #) and description of each label, as the plugin creates it.
export const LABEL_LOOK: Record<PluginLabel, { readonly color: string; readonly ru: string; readonly en: string }> = {
  'agent-queue': { color: '0e8a16', ru: 'Agent Queue: задача в очереди', en: 'Agent Queue: task in the queue' },
  'agent-queue:working': { color: '1d76db', ru: 'Agent Queue: задача в работе', en: 'Agent Queue: task in work' },
  'agent-queue:blocked': {
    color: 'd93f0b',
    ru: 'Agent Queue: задача ждёт ответа владельца',
    en: 'Agent Queue: task waits for the owner',
  },
  'agent-queue:split': { color: 'fbca04', ru: 'Agent Queue: задача отдана на деление', en: 'Agent Queue: task being split' },
  'agent-queue:mvp': { color: '5319e7', ru: 'Agent Queue: задача «MVP»', en: 'Agent Queue: the MVP issue' },
  'agent-queue:autopilot': {
    color: 'c5def5',
    ru: 'Agent Queue: автопилот MVP включён',
    en: 'Agent Queue: MVP autopilot is on',
  },
  'agent-queue:paused': {
    color: 'b60205',
    ru: 'Agent Queue: очередь проекта на паузе',
    en: 'Agent Queue: the project queue is paused',
  },
}

export function labelDescription(label: PluginLabel, language: GitHubLanguage): string {
  return LABEL_LOOK[label][language]
}
