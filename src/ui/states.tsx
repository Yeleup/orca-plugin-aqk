// The common states of a screen, as on the design board: loading — placeholder rows; error — the error text and
// «Повторить».
import { Button, Callout, Skeleton, Stack, Text } from 'orca'
import { t } from './language'

const ROWS = [0, 1, 2, 3, 4]

/** Placeholder rows while a screen waits for its data. Without `label` (language not read yet) Orca names them itself. */
export function LoadingRows(props: { label?: string }) {
  return (
    <Stack gap="sm">
      {ROWS.map((row) => (
        <Skeleton key={row} shape="text" lines={2} label={props.label} />
      ))}
    </Stack>
  )
}

/** The error of a screen's request and «Повторить», which runs that request again. */
export function RequestError(props: { message: string; onRetry: () => unknown }) {
  return (
    <Callout tone="danger" title={t('state.error')}>
      <Stack gap="sm">
        <Text>{props.message}</Text>
        <Button tone="accent" icon="refresh" onPress={props.onRetry}>
          {t('state.retry')}
        </Button>
      </Stack>
    </Callout>
  )
}
