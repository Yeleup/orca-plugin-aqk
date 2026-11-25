// Runs src/worker.ts's activate(orca) over Orca's mock host (`orca plugin test`).
import { assert, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('the worker starts without host calls or refusals', async () => {
  const worker = await mountWorker(main)
  assert.deepEqual(worker.logs, ['agent-queue-kit: worker started'])
  assert.deepEqual(worker.host.calls, [])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
