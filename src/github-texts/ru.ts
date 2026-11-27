// The Russian catalog of the texts the plugin writes to GitHub, for a project whose language is `ru`: the same keys as
// ./en.ts, no more and no fewer (the type checks it).
import type { GithubTextKey } from './en'

export const ru: { readonly [K in GithubTextKey]: string } = {
  'pr.closes': 'Closes #{issue}',
  'mvp.standMissing': 'Добавьте стенд приёмки в настройки проекта',

  'connect.commitTitle': 'Agent Queue: подключение проекта к очереди',

  'entryRule.title': 'Agent Queue: очередь задач этого проекта',
  'entryRule.who':
    'Это правило — только для входных сессий: агентов в основном чекауте этого проекта. Агент в worktree задачи очереди (исполнитель, ревьюер) его не выполняет: он делает задание, которое получил.',
  'entryRule.queue':
    'Изменение кода этого проекта (новая функция, исправление ошибки, рефакторинг, миграция, правка интерфейса) делает очередь Agent Queue, а не сессия:',
  'entryRule.questions': 'Сначала выясните с пользователем все открытые вопросы: очередь берёт задачу, не спрашивая вас.',
  'entryRule.create': 'Поставьте задачу в очередь — issue репозитория {repository} с меткой `agent-queue`:',
  'entryRule.command': 'gh issue create --repo {repository} --label agent-queue --title "<короткий заголовок>" --body-file <файл с текстом>',
  'entryRule.format':
    'В тексте задачи держите раздельно: «Запрос пользователя» (дословно, цитатой), «Решения пользователя» и «Предложения сессии».',
  'entryRule.depends':
    'Задача, которой нужен код другой открытой задачи, получает строку «Зависит от #N» отдельной строкой текста: очередь берёт её, когда #N закрыта.',
  'entryRule.data':
    'В задаче нет данных с прода и из реальных разговоров: имён, телефонов, адресов, идентификаторов реальных клиентов, ключей и токенов.',
  'entryRule.answer': 'Ответьте пользователю ссылкой на задачу.',
  'entryRule.self': 'Если пользователь говорит «сделай сам» или «без очереди», сессия делает изменение сама.',
  'entryRule.settings':
    'Настройки очереди — `.agent-queue.json` и `.agent-queue.md` — меняет только владелец, не задача очереди и не сессия.',
}
