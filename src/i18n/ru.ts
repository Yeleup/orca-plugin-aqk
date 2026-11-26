// The Russian string catalog of the panel: the same keys as ./en.ts, no more and no fewer (the type checks it).
import type { MessageKey } from './en'

export const ru: { readonly [K in MessageKey]: string } = {
  'app.title': 'Agent Queue',
  'nav.back': 'Назад',

  'state.loading': 'Загрузка…',
  'state.error': 'Ошибка',
  'state.retry': 'Повторить',

  'queue.project': 'Проект',
  'queue.projectsError': 'Не удалось прочитать подключённые проекты: {error}',
  'menu.doctor': 'Проверка проекта',
  'menu.mvpStart': 'Начать MVP',
  'menu.settings': 'Настройки',
  'menu.connect': 'Подключить проект',

  'screen.task': 'Задача',
  'screen.newTask': 'Новая задача',
  'screen.answer': 'Ответ на блокировку',
  'screen.connect': 'Подключение проекта',
  'screen.doctor': 'Проверка проекта',
  'screen.settings': 'Настройки',
  'screen.mvp': 'MVP',
  'screen.mvpStart': 'Старт MVP',
}
