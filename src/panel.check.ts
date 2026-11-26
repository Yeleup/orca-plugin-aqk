// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh host; a scenario's
// `requests` stand in for the worker. Orca itself never loads this file. The project names are invented.
import { defineCheck, hostError } from 'orca/testing'

const projects = [
  { id: 'shop-demo', hostId: 'local', name: 'shop-demo' },
  { id: 'blog-demo', hostId: 'local', name: 'blog-demo' },
]

export default defineCheck({
  // The worker as it is: no connected projects yet.
  worker: {},
  english: { requests: { 'projects.list': { projects } } },
  russian: { settings: { interfaceLanguage: 'ru' }, requests: { 'projects.list': { projects } } },
  dark: { theme: 'dark', settings: { interfaceLanguage: 'ru' }, requests: { 'projects.list': { projects } } },
  light: { theme: 'light', requests: { 'projects.list': { projects } } },
  error: {
    settings: { interfaceLanguage: 'ru' },
    requests: {
      'projects.list': () => {
        throw hostError('action_failed', 'worker stopped')
      },
    },
  },
})
