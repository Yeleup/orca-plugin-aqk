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

  'settings.language': 'Язык интерфейса',
  'settings.languageEnglish': 'English',
  'settings.languageRussian': 'Русский',
  'settings.interval': 'Интервал проверки очереди, минут',
  'settings.intervalInvalid': 'Введите целое число минут, не меньше {min}',
  'settings.mergeNotifications': 'Уведомления о мержах',
  'settings.coordinator': 'Координатор на этом компьютере',
  'settings.project': 'Настройки проекта',
  'settings.configFile': '.agent-queue.json',
  'settings.rulesFile': '.agent-queue.md',
  'settings.openFile': 'Открывает файл в редакторе Orca',
  'settings.noProjects': 'Нет подключённых проектов',
  'settings.saved': 'Сохранено.',
  'settings.savedNotificationsOff': 'Сохранено: уведомлений о мержах не будет, о блокировках — будут.',
  'settings.savedCoordinatorOff':
    'Сохранено: координатор этого компьютера не берёт и не ведёт задачи; панель только показывает очередь.',
  'settings.savedBothOff': 'Сохранено: уведомлений о мержах нет, координатор этого компьютера задачи не берёт.',
  'settings.saveError': 'Не удалось сохранить: {error}',
  'settings.readError': 'Не удалось прочитать настройки: {error}',
  'settings.openError': 'Не удалось открыть {file}: {error}',
  'settings.noCheckout': 'в Orca нет основного чекаута этого проекта',
}
