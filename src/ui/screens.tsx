// The screens of the ТЗ («Экраны») other than «Очередь». Each is a placeholder for now — its frame, «Назад» and its
// title; the task of each screen's function fills it with its data and states (ТЗ, «Экраны»; docs/mvp/plan.md).
import { Stack, type OrcaNode } from 'orca'
import type { MessageKey } from '../i18n/catalog'
import { ScreenHeader } from './header'
import { t } from './language'
import type { ScreenName } from './navigation'

export type OtherScreen = Exclude<ScreenName, 'queue'>

/** Each screen's title in the string catalogs. */
export const SCREEN_TITLES: { readonly [S in OtherScreen]: MessageKey } = {
  task: 'screen.task',
  newTask: 'screen.newTask',
  answer: 'screen.answer',
  connect: 'screen.connect',
  doctor: 'screen.doctor',
  settings: 'screen.settings',
  mvp: 'screen.mvp',
  mvpStart: 'screen.mvpStart',
}

/** A screen's frame: «Назад» and its title at the top, then its content. */
export function ScreenFrame(props: { screen: OtherScreen; children?: OrcaNode }) {
  return (
    <Stack gap="md">
      <ScreenHeader title={t(SCREEN_TITLES[props.screen])} back />
      {props.children}
    </Stack>
  )
}
