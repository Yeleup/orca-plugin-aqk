// «Подключение проекта» (ТЗ «Экраны», Ф1): a wizard of three steps — 1 the git projects of Orca (those of this computer
// not connected yet; a project on agent-queue-kit and a project of another host are marked and cannot be chosen); 2 the
// checks, one after another, each with its status and what to do: git and its GitHub repository (none — «Подключение
// невозможно: нет удалённого репозитория GitHub», the form does not open), gh (no login — «gh: нет входа — выполните gh
// auth login»: «Подключить» is not there), the agents Orca knows (a default agent it does not know does not stop the
// form: the owner picks another); 3 the settings form with its defaults, and «Подключить». The worker checks everything
// again and connects (src/connect/connect.ts): «Подключаю…» while it runs, however long — the worker answers `running`
// within its answer window and the screen asks again; a refusal names its reason and that nothing is written, with
// «Проверить снова»; a rejected push says the commit is undone, with «Повторить»; errors of the fields stand at their
// fields and keep «Подключить» unavailable until the field changes — the agents' choices are those Orca knows now.
// Connected — «Проверка проекта» of that project, but only while the owner is still on this screen of this attempt.
import {
  atom,
  Box,
  Button,
  Callout,
  EmptyState,
  Field,
  Input,
  plugin,
  read,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Text,
  Textarea,
  type Tone,
} from 'orca'
import type { MessageKey } from '../i18n/catalog'
import { dataRuleTemplate, taskRulesTemplate } from '../project/templates'
import type {
  AgentsCheck,
  AgentsFailure,
  ConnectCandidate,
  ConnectFailure,
  ConnectField,
  ConnectForm,
  ConnectRefusal,
  ConnectResult,
  FieldError,
  GhCheck,
  GitCheck,
  OrcaAgent,
  RoleAgents,
} from '../protocol'
import { language, t } from './language'
import { openScreen, route, whenOpened } from './navigation'
import { connectedProjects, selectedProject } from './queue'
import { errorMessage, resource } from './request'
import { ScreenFrame } from './screens'
import { LoadingRows, RequestError } from './states'

const ROLES = ['implementer', 'reviewer', 'solver', 'start'] as const
type Role = (typeof ROLES)[number]
const ROLE_LABELS: { readonly [R in Role]: MessageKey } = {
  implementer: 'connect.implementer',
  reviewer: 'connect.reviewer',
  solver: 'connect.solver',
  start: 'connect.start',
}

/** How long the worker may take for a check or for «Подключить» before it answers: the longest a panel's request may
 *  wait. «Подключить» and `connect.wait` answer `running` sooner (CONNECT_ANSWER_MS). */
const LONG_REQUEST = { timeoutMs: 120_000 }

/** How long the agents' CLI may take, in seconds (src/platform/orca-agents.ts). */
const AGENTS_TIMEOUT_SECONDS = 30

/** Step 1: the Orca projects the worker offers. */
export const connectCandidates = resource(async () => (await plugin.request('connect.projects')).projects)

/** A check of step 2: waiting for the one before it, running, its answer, or the worker's error. */
type CheckState<T> =
  | { readonly state: 'waiting' }
  | { readonly state: 'running' }
  | { readonly state: 'done'; readonly result: T }
  | { readonly state: 'error'; readonly error: string }

type Checks = {
  readonly project: ConnectCandidate
  readonly git: CheckState<GitCheck>
  readonly gh: CheckState<GhCheck>
  readonly agents: CheckState<AgentsCheck>
  // Whether the form opened when the checks ended: once open, it stays open after «Подключить», whatever the worker
  // then says of the agents — the errors of their fields stand there.
  readonly opened: boolean
}

/** Where the wizard is. */
type Wizard =
  | { readonly step: 'choose' }
  | ({ readonly step: 'checks' } & Checks)
  | ({ readonly step: 'connecting' } & Checks)
  | ({ readonly step: 'outcome'; readonly outcome: Outcome } & Checks)

/** What «Подключить» ended with, when it did not connect. */
type Outcome =
  | { readonly kind: 'refused'; readonly refusal: ConnectRefusal }
  | { readonly kind: 'pushRejected'; readonly error: string }
  | { readonly kind: 'failed'; readonly failure: ConnectFailure }

/** The form as the owner fills it in: null data rule and rules for tasks follow their templates until edited. */
type FormState = Omit<ConnectForm, 'dataRule' | 'taskRules'> & { readonly dataRule: string | null; readonly taskRules: string | null }

export const wizard = atom<Wizard>({ step: 'choose' })
const form = atom<{ readonly project: string; readonly values: FormState } | null>(null)
const fieldErrors = atom<FieldError[]>([])
// The attempt of the wizard that may still change it: every opening of the screen, check and «Подключить» is a new one.
let runs = 0

whenOpened('connect', startConnect)

/** Opening the screen: the wizard starts over at step 1. */
export function startConnect(): void {
  runs++
  set(wizard, { step: 'choose' })
  set(form, null)
  set(fieldErrors, [])
  void connectCandidates.load()
}

/** Whether attempt `mine` is still the one on screen: no later attempt, and the owner is still on «Подключение
 *  проекта». */
function current(mine: number): boolean {
  return mine === runs && read(route).screen === 'connect'
}

/** «Выбрать» or «Проверить снова»: the checks of step 2, one after another. The form keeps what was filled in for the
 *  same project; the errors of its fields go — «Подключить» checks them again. */
async function runChecks(project: ConnectCandidate): Promise<void> {
  const mine = ++runs
  const target = { projectId: project.id, hostId: project.hostId }
  let checks: Checks = { project, git: { state: 'running' }, gh: { state: 'waiting' }, agents: { state: 'waiting' }, opened: false }
  const show = (next: Checks) => {
    checks = next
    if (current(mine)) set(wizard, { step: 'checks', ...checks })
  }
  set(fieldErrors, [])
  show(checks)
  const git = await ask(() => plugin.request('connect.checkGit', target, LONG_REQUEST))
  show({ ...checks, git })
  if (git.state !== 'done' || git.result.status !== 'ok') return
  show({ ...checks, gh: { state: 'running' } })
  const gh = await ask(() => plugin.request('connect.checkGh', target, LONG_REQUEST))
  show({ ...checks, gh, agents: { state: 'running' } })
  const agents = await ask(() => plugin.request('connect.checkAgents', target, LONG_REQUEST))
  if (!current(mine)) return
  const kept = read(form)
  const ended = { ...checks, agents }
  const done = { ...ended, opened: formOpens(ended) }
  if (done.opened && (kept === null || kept.project !== project.id)) set(form, { project: project.id, values: initialForm(done) })
  show(done)
}

async function ask<T>(request: () => Promise<T>): Promise<CheckState<T>> {
  try {
    return { state: 'done', result: await request() }
  } catch (error) {
    return { state: 'error', error: errorMessage(error) }
  }
}

/** Whether the checks let the form open: git and gh pass, the agents' list was read and is not empty. */
function formOpens(checks: Checks): boolean {
  const { git, gh, agents } = checks
  return (
    git.state === 'done' &&
    git.result.status === 'ok' &&
    gh.state === 'done' &&
    gh.result.status === 'ok' &&
    agents.state === 'done' &&
    (agents.result.status === 'ok' || (agents.result.status === 'problem' && agents.result.problem === 'missing'))
  )
}

/** The base branches the form offers: GitHub's default branch first, then the branches of `origin` the clone knows. */
function baseBranches(checks: Checks): { readonly branches: readonly string[]; readonly main: string } {
  const git = checks.git.state === 'done' && checks.git.result.status === 'ok' ? checks.git.result : null
  const github = checks.gh.state === 'done' && checks.gh.result.status === 'ok' ? checks.gh.result.defaultBranch : null
  const main = github ?? git?.defaultBranch ?? ''
  return { branches: [...new Set([main, ...(git?.branches ?? [])].filter((branch) => branch !== ''))], main }
}

function initialForm(checks: Checks): FormState {
  const known = knownAgents(checks.agents)
  const agents = checks.agents
  const defaults = agents.state === 'done' && 'defaults' in agents.result ? agents.result.defaults : null
  const pick = (role: Role) => {
    const id = defaults?.[role]
    return id !== undefined && known.some((agent) => agent.id === id) ? id : null
  }
  return {
    baseBranch: baseBranches(checks).main,
    testCommand: '',
    testCommandWindows: '',
    agents: { implementer: pick('implementer'), reviewer: pick('reviewer'), solver: pick('solver'), start: pick('start') },
    language: read(language) ?? 'en',
    dataRule: null,
    taskRules: null,
    maxInProgress: '1',
    worktreeMode: 'shared',
    directories: '',
  }
}

function knownAgents(agents: CheckState<AgentsCheck>): readonly OrcaAgent[] {
  return agents.state === 'done' && 'agents' in agents.result ? agents.result.agents : []
}

/** What «Подключить» sends: the templates the owner did not edit as the form shows them. */
function formToSend(values: FormState): ConnectForm {
  return { ...values, dataRule: shownDataRule(values), taskRules: shownTaskRules(values) }
}

function shownDataRule(values: FormState): string {
  return values.dataRule ?? dataRuleTemplate(values.language)
}

function shownTaskRules(values: FormState): string {
  return (
    values.taskRules ??
    taskRulesTemplate({ language: values.language, testCommand: values.testCommand.trim(), testCommandWindows: values.testCommandWindows })
  )
}

function changeForm(field: ConnectField | null, change: (values: FormState) => FormState): void {
  const filled = read(form)
  if (filled === null) return
  set(form, { project: filled.project, values: change(filled.values) })
  if (field !== null) set(fieldErrors, read(fieldErrors).filter((error) => error.field !== field))
}

/** «Подключить» (and «Повторить» after a rejected push or a failure): the worker checks everything again and connects;
 *  while it answers `running`, the screen asks again. A late answer changes nothing once the owner left the screen or
 *  began another attempt; the connected projects are refreshed anyway. */
async function submit(): Promise<void> {
  const now = read(wizard)
  const filled = read(form)
  if (now.step === 'choose' || filled === null) return
  let checks: Checks = { project: now.project, git: now.git, gh: now.gh, agents: now.agents, opened: now.opened }
  const mine = ++runs
  set(wizard, { step: 'connecting', ...checks })
  const target = { projectId: checks.project.id, hostId: checks.project.hostId }
  let result = await answer(null, () => plugin.request('connect.connect', { ...target, form: formToSend(filled.values) }, LONG_REQUEST))
  while (result.status === 'running' && current(mine)) {
    const attempt = result.attempt
    result = await answer(attempt, () => plugin.request('connect.wait', { ...target, attempt }, LONG_REQUEST))
  }
  if (result.status === 'connected') void connectedProjects.load()
  if (!current(mine) || result.status === 'running') return
  if (result.status === 'connected') {
    set(selectedProject, result.project.id)
    set(wizard, { step: 'choose' })
    set(form, null)
    openScreen('doctor')
    return
  }
  if (result.status === 'fields') {
    if (result.agents !== null) checks = { ...checks, agents: { state: 'done', result: result.agents } }
    set(fieldErrors, result.errors)
    set(wizard, { step: 'checks', ...checks })
    return
  }
  const outcome: Outcome =
    result.status === 'refused'
      ? { kind: 'refused', refusal: result.refusal }
      : result.status === 'pushRejected'
        ? { kind: 'pushRejected', error: result.error }
        : { kind: 'failed', failure: result.failure }
  set(wizard, { step: 'outcome', outcome, ...checks })
}

/** The worker's answer. A wait for attempt `attempt` that timed out is asked again (`running`); any other error is a
 *  failure. */
async function answer(attempt: string | null, request: () => Promise<ConnectResult>): Promise<ConnectResult> {
  try {
    return await request()
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
    if (code === 'timeout' && attempt !== null) return { status: 'running', attempt }
    return { status: 'failed', failure: { step: 'unexpected', detail: errorMessage(error) }, operation: null }
  }
}

// ── Drawing ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export function ConnectScreen() {
  const now = read(wizard)
  return <ScreenFrame screen="connect">{now.step === 'choose' ? <ChooseStep /> : <ProjectSteps wizard={now} />}</ScreenFrame>
}

function Steps(props: { current: 1 | 2 | 3 }) {
  const step = (n: 1 | 2 | 3, key: MessageKey) => (
    <Text key={key} tone={n === props.current ? 'accent' : undefined} muted={n > props.current} weight={n === props.current ? 'semibold' : 'regular'}>
      {t(key)}
    </Text>
  )
  return (
    <Row wrap gap="xs" align="center">
      {step(1, 'connect.step1')}
      <Text muted>{t('connect.stepArrow')}</Text>
      {step(2, 'connect.step2')}
      <Text muted>{t('connect.stepArrow')}</Text>
      {step(3, 'connect.step3')}
    </Row>
  )
}

/** The line under a project of step 1: why it cannot be chosen, or its path and GitHub repository. */
function candidateLine(project: ConnectCandidate): string {
  if (project.otherHost) return t('connect.otherHost', { host: project.hostId })
  if (project.kit) return t('connect.kit')
  if (project.kitUnknown) return t('connect.kitUnknown')
  if (project.repository === null) return t('connect.candidateNoGithub', { path: project.path })
  return t('connect.candidateGithub', { path: project.path, repository: project.repository })
}

function ChooseStep() {
  const state = read(connectCandidates.state)
  return (
    <Stack gap="md">
      <Steps current={1} />
      {state.status === 'loading' ? <LoadingRows label={t('state.loading')} /> : null}
      {state.status === 'error' ? (
        <RequestError message={t('connect.candidatesError', { error: state.message })} onRetry={connectCandidates.load} />
      ) : null}
      {state.status === 'ready' && state.data.length === 0 ? <EmptyState title={t('connect.noCandidates')} icon="folder" /> : null}
      {state.status === 'ready' && state.data.length > 0 ? (
        <Stack gap="sm">
          <Text muted>{t('connect.candidates')}</Text>
          {state.data.map((project) => (
            <Box key={`${project.hostId}:${project.id}`} border radius="md" padding="sm" gap="xs">
              <Row gap="sm" align="center" justify="between">
                <Text weight="semibold" truncate>
                  {project.name}
                </Text>
                <Button
                  key={`choose:${project.hostId}:${project.id}`}
                  size="sm"
                  disabled={project.kit || project.kitUnknown || project.otherHost}
                  onPress={() => void runChecks(project)}
                >
                  {t('connect.choose')}
                </Button>
              </Row>
              <Text muted size="sm">
                {candidateLine(project)}
              </Text>
            </Box>
          ))}
        </Stack>
      ) : null}
    </Stack>
  )
}

/** A line of step 2: its icon and text in the tone of its status. */
type Line = { readonly key: string; readonly status: 'ok' | 'problem' | 'running' | 'waiting'; readonly text: string }

function gitLine(git: CheckState<GitCheck>, repository: string): Line {
  if (git.state === 'waiting' || git.state === 'running') return { key: 'git', status: 'running', text: t('connect.gitChecking') }
  if (git.state === 'error') return { key: 'git', status: 'problem', text: t('connect.gitUnchecked', { error: git.error }) }
  const result = git.result
  if (result.status === 'ok') return { key: 'git', status: 'ok', text: t('connect.gitOk', { repository: result.repository }) }
  if (result.status === 'unchecked') return { key: 'git', status: 'problem', text: t('connect.gitUnchecked', { error: result.error }) }
  const texts = {
    'not-git': 'connect.notGit',
    'no-github': 'connect.noGithub',
    'push-elsewhere': 'connect.pushElsewhere',
    'no-branches': 'connect.noBranches',
  } as const
  return { key: 'git', status: 'problem', text: t(texts[result.problem], { repository }) }
}

function ghLine(gh: CheckState<GhCheck>, repository: string): Line {
  if (gh.state === 'waiting') return { key: 'gh', status: 'waiting', text: t('connect.ghWaiting') }
  if (gh.state === 'running') return { key: 'gh', status: 'running', text: t('connect.ghChecking') }
  if (gh.state === 'error') return { key: 'gh', status: 'problem', text: t('connect.ghUnchecked', { error: gh.error }) }
  const result = gh.result
  if (result.status === 'ok') return { key: 'gh', status: 'ok', text: t('connect.ghOk') }
  if (result.status === 'unchecked') return { key: 'gh', status: 'problem', text: t('connect.ghUnchecked', { error: result.error }) }
  const texts = {
    'not-installed': 'connect.ghNotInstalled',
    'not-logged-in': 'connect.ghNotLoggedIn',
    'no-repository': 'connect.ghNoRepository',
    'no-write': 'connect.ghNoWrite',
  } as const
  return { key: 'gh', status: 'problem', text: t(texts[result.problem], { repository }) }
}

/** Why the agents of Orca could not be read, in the panel's language; the CLI is named by the file that ran. */
function agentsFailureText(failure: AgentsFailure): string {
  switch (failure.kind) {
    case 'cli-not-found':
      return t('connect.agentsCliNotFound', { detail: failure.search })
    case 'not-started':
      return t('connect.agentsNotStarted', { cli: failure.cli, detail: failure.detail })
    case 'timed-out':
      return t('connect.agentsTimedOut', { cli: failure.cli, seconds: AGENTS_TIMEOUT_SECONDS })
    case 'refused':
      return t('connect.agentsOrcaRefused', { detail: failure.detail })
    case 'no-json':
      return t('connect.agentsNoJson', { cli: failure.cli, detail: failure.detail })
    case 'no-list':
      return t('connect.agentsNoList', { cli: failure.cli })
    case 'no-id':
      return t('connect.agentsNoId', { cli: failure.cli })
    case 'not-ok':
      return t('connect.agentsNotOk', { cli: failure.cli, detail: failure.detail })
  }
}

function agentsLine(agents: CheckState<AgentsCheck>): Line {
  if (agents.state === 'waiting') return { key: 'agents', status: 'waiting', text: t('connect.agentsWaiting') }
  if (agents.state === 'running') return { key: 'agents', status: 'running', text: t('connect.agentsChecking') }
  if (agents.state === 'error') return { key: 'agents', status: 'problem', text: t('connect.agentsUnchecked', { reason: agents.error }) }
  const result = agents.result
  if (result.status === 'ok') {
    return { key: 'agents', status: 'ok', text: t('connect.agentsOk', { agents: uniqueRoles(result.defaults).join(', ') }) }
  }
  if (result.status === 'unchecked') {
    return { key: 'agents', status: 'problem', text: t('connect.agentsUnchecked', { reason: agentsFailureText(result.failure) }) }
  }
  if (result.problem === 'empty') return { key: 'agents', status: 'problem', text: t('connect.agentsEmpty') }
  return { key: 'agents', status: 'problem', text: t('connect.agentsMissing', { agents: result.missing.join(', ') }) }
}

function uniqueRoles(defaults: RoleAgents<string>): string[] {
  return [...new Set(ROLES.map((role) => defaults[role]))]
}

const LINE_LOOK: { readonly [S in Line['status']]: { readonly icon: MessageKey; readonly tone: Tone | undefined } } = {
  ok: { icon: 'connect.iconOk', tone: 'success' },
  problem: { icon: 'connect.iconProblem', tone: 'danger' },
  running: { icon: 'connect.iconRunning', tone: undefined },
  waiting: { icon: 'connect.iconWaiting', tone: undefined },
}

function CheckLine(props: { line: Line }) {
  const look = LINE_LOOK[props.line.status]
  return (
    <Row gap="sm" align="start">
      <Text tone={look.tone} muted={look.tone === undefined} weight="semibold">
        {t(look.icon)}
      </Text>
      <Text tone={props.line.status === 'problem' ? 'danger' : undefined}>{props.line.text}</Text>
    </Row>
  )
}

function ProjectSteps(props: { wizard: Exclude<Wizard, { step: 'choose' }> }) {
  const checks = props.wizard
  const git = checks.git
  const gitOk = git.state === 'done' && git.result.status === 'ok'
  const repository = git.state === 'done' && git.result.status === 'ok' ? git.result.repository : (checks.project.repository ?? '')
  const lines = [gitLine(git, repository), ...(gitOk ? [ghLine(checks.gh, repository), agentsLine(checks.agents)] : [])]
  const opens = checks.opened
  if (props.wizard.step === 'connecting') {
    return (
      <Stack gap="md">
        <Steps current={3} />
        <Row gap="sm" align="center">
          <Spinner label={t('connect.connecting')} labelHidden />
          <Text>{t('connect.connecting')}</Text>
        </Row>
      </Stack>
    )
  }
  if (props.wizard.step === 'outcome') return <OutcomeView outcome={props.wizard.outcome} project={checks.project} />
  const finished = lines.every((line) => line.status === 'ok' || line.status === 'problem')
  return (
    <Stack gap="md">
      <Steps current={opens ? 3 : 2} />
      <Text muted>{t('connect.project', { name: checks.project.name })}</Text>
      <Stack gap="xs">
        {lines.map((line) => (
          <CheckLine key={line.key} line={line} />
        ))}
      </Stack>
      {finished && !opens ? <Blocked checks={checks} /> : null}
      {opens ? <SettingsForm checks={checks} /> : null}
    </Stack>
  )
}

/** A check that stops the wizard: what to do, and «Проверить снова» (or, without a GitHub repository, back to step 1). */
function Blocked(props: { checks: Checks }) {
  const { git, gh } = props.checks
  if (git.state === 'done' && git.result.status === 'problem' && git.result.problem === 'no-github') {
    return (
      <Callout tone="danger">
        <Stack gap="sm">
          <Text>{t('connect.noGithubFix')}</Text>
          <Row>
            <Button tone="accent" onPress={startConnect}>
              {t('connect.toProjects')}
            </Button>
          </Row>
        </Stack>
      </Callout>
    )
  }
  const login = gh.state === 'done' && gh.result.status === 'problem' && gh.result.problem === 'not-logged-in'
  return (
    <Callout tone="danger">
      <Stack gap="sm">
        <Text>{t('connect.blocked', { fix: t(login ? 'connect.fixLogin' : 'connect.fixOther') })}</Text>
        <Row>
          <Button tone="accent" icon="refresh" onPress={() => void runChecks(props.checks.project)}>
            {t('connect.checkAgain')}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

const FIELD_ERRORS: { readonly [C in FieldError['code']]: MessageKey } = {
  required: 'connect.errorTestCommand',
  oneLine: 'connect.errorOneLine',
  agent: 'connect.errorAgent',
  number: 'connect.errorNumber',
  'branch-name': 'connect.errorBranchName',
  'no-branch': 'connect.errorNoBranch',
  directory: 'connect.errorDirectory',
  masked: 'connect.errorMasked',
  invalid: 'connect.errorInvalid',
}
const REQUIRED: { readonly [F in ConnectField]?: MessageKey } = {
  testCommand: 'connect.errorTestCommand',
  dataRule: 'connect.errorDataRule',
  taskRules: 'connect.errorTaskRules',
}

function errorOf(field: ConnectField): string | undefined {
  const error = read(fieldErrors).find((one) => one.field === field)
  if (error === undefined) return undefined
  const key = error.code === 'required' ? (REQUIRED[field] ?? FIELD_ERRORS.required) : FIELD_ERRORS[error.code]
  return t(key, { detail: error.detail })
}

function SettingsForm(props: { checks: Checks }) {
  const filled = read(form)
  if (filled === null) return null
  const values = filled.values
  const { branches } = baseBranches(props.checks)
  const agents = knownAgents(props.checks.agents)
  const errors = read(fieldErrors)
  const text = (field: 'testCommand' | 'testCommandWindows' | 'maxInProgress' | 'directories', label: MessageKey, placeholder?: MessageKey) => (
    <Field label={t(label)} error={errorOf(field)} required={field === 'testCommand'}>
      <Input
        label={t(label)}
        labelHidden
        value={values[field]}
        placeholder={placeholder === undefined ? undefined : t(placeholder)}
        invalid={errorOf(field) !== undefined}
        onChange={(value) => changeForm(field, (now) => ({ ...now, [field]: value }))}
      />
    </Field>
  )
  return (
    <Stack gap="md">
      <Field label={t('connect.baseBranch')} error={errorOf('baseBranch')}>
        <Select
          label={t('connect.baseBranch')}
          labelHidden
          options={branches.map((branch) => ({ value: branch, label: branch }))}
          value={values.baseBranch}
          onChange={(value) => changeForm('baseBranch', (now) => ({ ...now, baseBranch: value }))}
        />
      </Field>
      {text('testCommand', 'connect.testCommand')}
      {text('testCommandWindows', 'connect.testCommandWindows')}
      {ROLES.map((role) => (
        <Field key={role} label={t(ROLE_LABELS[role])} error={errorOf(`agents.${role}`)}>
          <Select
            label={t(ROLE_LABELS[role])}
            labelHidden
            options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
            value={values.agents[role] ?? undefined}
            placeholder={t('connect.chooseAgent')}
            onChange={(value) => changeForm(`agents.${role}`, (now) => ({ ...now, agents: { ...now.agents, [role]: value } }))}
          />
        </Field>
      ))}
      <Field label={t('connect.language')} error={errorOf('language')}>
        <Select
          label={t('connect.language')}
          labelHidden
          options={[
            { value: 'ru', label: t('connect.languageRussian') },
            { value: 'en', label: t('connect.languageEnglish') },
          ]}
          value={values.language}
          onChange={(value) => changeForm('language', (now) => ({ ...now, language: value === 'ru' ? 'ru' : 'en' }))}
        />
      </Field>
      {text('maxInProgress', 'connect.maxInProgress')}
      <Field label={t('connect.worktreeMode')} error={errorOf('worktreeMode')}>
        <Select
          label={t('connect.worktreeMode')}
          labelHidden
          options={[
            { value: 'shared', label: t('connect.worktreeShared') },
            { value: 'own', label: t('connect.worktreeOwn') },
          ]}
          value={values.worktreeMode}
          onChange={(value) => changeForm('worktreeMode', (now) => ({ ...now, worktreeMode: value === 'own' ? 'own' : 'shared' }))}
        />
      </Field>
      {text('directories', 'connect.directories', 'connect.directoriesHint')}
      <Field label={t('connect.dataRule')} error={errorOf('dataRule')} required>
        <Textarea
          label={t('connect.dataRule')}
          labelHidden
          rows={3}
          value={shownDataRule(values)}
          invalid={errorOf('dataRule') !== undefined}
          onChange={(value) => changeForm('dataRule', (now) => ({ ...now, dataRule: value }))}
        />
      </Field>
      <Field label={t('connect.taskRules')} error={errorOf('taskRules')} required>
        <Textarea
          label={t('connect.taskRules')}
          labelHidden
          rows={8}
          value={shownTaskRules(values)}
          invalid={errorOf('taskRules') !== undefined}
          onChange={(value) => changeForm('taskRules', (now) => ({ ...now, taskRules: value }))}
        />
      </Field>
      {agents.length === 0 ? (
        <Callout tone="danger">
          <Stack gap="sm">
            <Text>{t('connect.blocked', { fix: t('connect.fixOther') })}</Text>
            <Row>
              <Button tone="accent" icon="refresh" onPress={() => void runChecks(props.checks.project)}>
                {t('connect.checkAgain')}
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      <Row>
        <Button tone="accent" variant="solid" disabled={errors.length > 0 || agents.length === 0} onPress={() => void submit()}>
          {t('connect.connect')}
        </Button>
      </Row>
    </Stack>
  )
}

/** Why «Подключить» did not connect, and what to press next. */
function OutcomeView(props: { outcome: Outcome; project: ConnectCandidate }) {
  const { outcome } = props
  if (outcome.kind === 'refused') {
    return (
      <Callout tone="danger" title={t('connect.refusedTitle')}>
        <Stack gap="sm">
          <Text>{`${refusalText(outcome.refusal, props.project.repository ?? '')} ${t('connect.nothingWritten')}`}</Text>
          <Row>
            <Button tone="accent" icon="refresh" onPress={() => void runChecks(props.project)}>
              {t('connect.checkAgain')}
            </Button>
          </Row>
        </Stack>
      </Callout>
    )
  }
  const message = outcome.kind === 'pushRejected' ? t('connect.pushRejected', { error: outcome.error }) : failureText(outcome.failure)
  const lost = outcome.kind === 'failed' && outcome.failure.step === 'lost'
  return (
    <Callout tone="danger">
      <Stack gap="sm">
        <Text>{message}</Text>
        <Row>
          <Button tone="accent" icon="refresh" onPress={() => void (lost ? startConnect() : submit())}>
            {t('state.retry')}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

function refusalText(refusal: ConnectRefusal, repository: string): string {
  switch (refusal.reason) {
    case 'kit':
      return t('connect.kitRefused')
    case 'kit-unknown':
      return t('connect.kitUnknownRefused')
    case 'busy':
      return t('connect.busy')
    case 'connected':
      return t('connect.connectedRefused')
    case 'git':
      return gitLine({ state: 'done', result: refusal.check }, repository).text
    case 'gh':
      return ghLine({ state: 'done', result: refusal.check }, repository).text
    case 'agents':
      return t('connect.agentsRefused', { reason: agentsFailureText(refusal.failure) })
    case 'fetch':
      return t('connect.fetchFailed', { error: refusal.error })
    case 'not-on-base':
      return refusal.branch === null
        ? t('connect.notOnBranch', { base: refusal.base })
        : t('connect.notOnBase', { base: refusal.base, branch: refusal.branch })
    case 'dirty':
      return t('connect.dirty', { paths: refusal.paths })
    case 'behind':
      return t('connect.behind', { base: refusal.base, commits: refusal.commits })
    case 'ahead':
      return t('connect.ahead', { base: refusal.base, commits: refusal.commits })
    case 'diverged':
      return t('connect.diverged', { base: refusal.base, ahead: refusal.ahead, behind: refusal.behind })
    case 'file': {
      const keys = {
        present: 'connect.filePresent',
        differs: 'connect.fileDiffers',
        ignored: 'connect.fileIgnored',
        transformed: 'connect.fileTransformed',
        'not-text': 'connect.fileNotText',
        'not-file': 'connect.fileNotFile',
        unpaired: 'connect.fileUnpaired',
        masked: 'connect.fileMasked',
      } as const
      const unpaired = { 'begin-again': 'connect.unpairedBeginAgain', 'end-alone': 'connect.unpairedEndAlone', 'begin-alone': 'connect.unpairedBeginAlone' } as const
      const detail =
        refusal.problem === 'unpaired' && refusal.detail in unpaired ? t(unpaired[refusal.detail as keyof typeof unpaired]) : refusal.detail
      return t(keys[refusal.problem], { file: refusal.file, detail })
    }
    case 'journal':
      return t('connect.journalRefused', { error: refusal.error })
  }
}

function failureText(failure: ConnectFailure): string {
  const left = (paths: readonly string[]) => (paths.length > 0 ? ` ${t('connect.left', { paths: paths.join(', ') })}` : '')
  switch (failure.step) {
    case 'labels':
      return t('connect.failedLabels', { detail: failure.detail })
    case 'changed': {
      const change = failure.change
      const what =
        change.kind === 'head'
          ? t('connect.changedHead')
          : change.kind === 'branch'
            ? t('connect.changedBranch')
            : change.kind === 'dirty'
              ? t('connect.changedDirty', { paths: change.paths })
              : t('connect.changedFile', { file: change.file })
      return t('connect.failedChanged', { what })
    }
    case 'files':
      return failure.reason === 'changed'
        ? `${t('connect.failedFilesChanged', { file: failure.file })}${left(failure.left)}`
        : `${t('connect.failedFiles', { detail: `${failure.file}: ${failure.detail ?? ''}` })}${left(failure.left)}`
    case 'commit':
      return failure.reason === 'moved'
        ? `${t('connect.failedCommitMoved')}${left(failure.left)}`
        : `${t('connect.failedCommit', { detail: failure.detail ?? '' })}${left(failure.left)}`
    case 'verify': {
      const what =
        failure.what === 'parent'
          ? t('connect.verifyParent')
          : failure.what === 'paths'
            ? t('connect.verifyPaths')
            : failure.what === 'blob'
              ? t('connect.verifyBlob', { file: failure.file ?? '' })
              : t('connect.verifyMessage')
      return `${t('connect.failedVerify', { what })}${left(failure.left)}`
    }
    case 'push-unknown':
      return t('connect.failedPushUnknown', { detail: failure.detail })
    case 'push-address':
      return `${t('connect.failedPushAddress')}${left(failure.left)}`
    case 'undo':
      if (failure.reason === 'moved') return t('connect.failedUndoMoved', { push: failure.push ?? '' })
      return failure.push === null
        ? t('connect.failedUndo', { detail: failure.detail ?? '' })
        : t('connect.failedUndoPush', { push: failure.push, detail: failure.detail ?? '' })
    case 'unexpected':
      return t('connect.failed', { error: failure.detail })
    case 'lost':
      return t('connect.failedLost')
  }
}
