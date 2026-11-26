// The common states of a screen, as on the design board: loading — placeholder rows; error — the error text and
// «Повторить».
import { Box, Button, Callout, Skeleton, Stack, Text } from 'orca'
import { t } from './language'

const ROWS = [0, 1, 2, 3, 4]

/** Placeholder rows while a screen waits for its data, named for screen readers by `label` (a catalog text). */
export function LoadingRows(props: { label: string }) {
  return (
    <Stack gap="sm">
      {ROWS.map((row) => (
        <Skeleton key={row} shape="text" lines={2} label={props.label} />
      ))}
    </Stack>
  )
}

/**
 * Placeholder rows before the interface language is read: plain shapes with no name and no status. Orca draws every
 * Skeleton as a status named «Loading» in Orca's own language when it has no label, so the panel shows none until it
 * can name them from its catalog.
 */
export function BlankRows() {
  return (
    <Stack gap="sm">
      {ROWS.map((row) => (
        <Stack key={row} gap="xs">
          <Box background="muted" radius="sm" height={12} width="60%" />
          <Box background="muted" radius="sm" height={12} width="35%" />
        </Stack>
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
