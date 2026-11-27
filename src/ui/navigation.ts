// The panel's screens (ТЗ, «Экраны») and the move between them. The panel always opens on «Очередь»: the route is not
// persisted. Every other screen has «Назад» back to «Очередь».
import { atom, set } from 'orca'

export const SCREENS = [
  'queue', // «Очередь»
  'task', // «Задача»
  'newTask', // «Новая задача»
  'answer', // «Ответ на блокировку»
  'connect', // «Подключение проекта»
  'doctor', // «Проверка проекта»
  'settings', // «Настройки»
  'mvp', // «MVP»
  'mvpStart', // «Старт MVP»
] as const
export type ScreenName = (typeof SCREENS)[number]

/** Where the panel is. Screens that show one item (a task, an MVP) add what they need here. */
export type Route = { screen: ScreenName }

export const route = atom<Route>({ screen: 'queue' })

// What a screen starts each time it is opened (its first request), by screen: a screen registers it once.
const openers = new Map<ScreenName, () => void>()

/** Runs `start` each time `screen` is opened. */
export function whenOpened(screen: ScreenName, start: () => void): void {
  openers.set(screen, start)
}

export function openScreen(screen: ScreenName): void {
  set(route, { screen })
  openers.get(screen)?.()
}

/** «Назад»: back to «Очередь». */
export function backToQueue(): void {
  set(route, { screen: 'queue' })
}
