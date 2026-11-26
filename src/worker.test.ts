// Runs src/worker.ts's activate(orca) over Orca's mock host (`orca plugin test`).
import { assert, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('the worker starts without host calls or refusals', async () => {
  const worker = await mountWorker(main)
  assert.deepEqual(worker.logs, ['agent-queue: worker started'])
  assert.deepEqual(worker.host.calls, [])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

// Connecting projects is a later task (`connect`): until then the worker knows of none.
test('Каркас панели: воркер отвечает панели на projects.list — подключённых проектов пока нет', async () => {
  const worker = await mountWorker(main)
  assert.deepEqual(await worker.request('projects.list', undefined, { panel: 'agent-queue' }), { projects: [] })
  assert.deepEqual(worker.host.calls, [])
  assert.deepEqual(worker.refusals, [])
  assert.deepEqual(worker.posts, [])
  await worker.deactivate()
})
