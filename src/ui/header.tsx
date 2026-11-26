// The top of a screen: «Назад» to «Очередь» and the screen's title, with room on the right (a badge, a selector).
import { Box, Heading, Link, Row, Separator, Stack, type OrcaNode } from 'orca'
import { t } from './language'
import { backToQueue } from './navigation'

/** The top of «Очередь» (no «Назад») or, with `back`, of any other screen. */
export function ScreenHeader(props: { title: string; back?: boolean; children?: OrcaNode }) {
  return (
    <Stack gap="sm">
      <Row gap="sm" align="center" justify="between">
        <Row gap="sm" align="center">
          {props.back ? <Link onPress={backToQueue}>{t('nav.back')}</Link> : null}
          <Heading level={2}>{props.title}</Heading>
        </Row>
        {props.children ? <Box width="50%">{props.children}</Box> : null}
      </Row>
      <Separator />
    </Stack>
  )
}
