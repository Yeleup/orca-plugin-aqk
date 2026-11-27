// «Подключение проекта» (ТЗ «Экраны», Ф1): a wizard of three steps — 1 the Orca projects of this computer not connected
// yet (a project on agent-queue-kit is marked and cannot be chosen); 2 the checks, one after another, each with its
// status and what to do: git and its GitHub repository (none — «Подключение невозможно: нет удалённого репозитория
// GitHub», the form does not open), gh (no login — «gh: нет входа — выполните gh auth login»: «Подключить» is not
// there), the agents Orca knows (a default agent it does not know does not stop the form: the owner picks another);
// 3 the settings form with its defaults, and «Подключить». The worker checks everything again and connects
// (src/connect/connect.ts): «Подключаю…» while it runs; a refusal names its reason and that nothing is written, with
// «Проверить снова»; a rejected push says the commit is undone, with «Повторить»; errors of the fields stand at their
// fields and keep «Подключить» unavailable until the field changes. Connected — «Проверка проекта» of that project.
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
  ConnectCandidate,
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
import { openScreen, whenOpened } from './navigation'
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

/** How long the worker may take for a check or for «Подключить» (fetch, labels, commit, push): the longest a panel's
 *  request may wait. */
const LONG_REQUEST = { timeoutMs: 120_000 }

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
  | { readonly kind: 'failed'; readonly error: string }

/** The form as the owner fills it in: null data rule and rules for tasks follow their templates until edited. */
type FormState = Omit<ConnectForm, 'dataRule' | 'taskRules'> & { readonly dataRule: string | null; readonly taskRules: string | null }

export const wizard = atom<Wizard>({ step: 'choose' })
const form = atom<{ readonly project: string; readonly values: FormState } | null>(null)
const fieldErrors = atom<FieldError[]>([])
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

/** «Выбрать» or «Проверить снова»: the checks of step 2, one after another. The form keeps what was filled in for the
 *  same project. */
async function runChecks(project: ConnectCandidate): Promise<void> {
  const mine = ++runs
  const target = { projectId: project.id, hostId: project.hostId }
  let checks: Checks = { project, git: { state: 'running' }, gh: { state: 'waiting' }, agents: { state: 'waiting' } }
  const show = (next: Checks) => {
    checks = next
    if (mine === runs) set(wizard, { step: 'checks', ...checks })
  }
  show(checks)
  const git = await ask(() => plugin.request('connect.checkGit', target, LONG_REQUEST))
  show({ ...checks, git })
  if (git.state !== 'done' || git.result.status !== 'ok') return
  show({ ...checks, gh: { state: 'running' } })
  const gh = await ask(() => plugin.request('connect.checkGh', target, LONG_REQUEST))
  show({ ...checks, gh, agents: { state: 'running' } })
  const agents = await ask(() => plugin.request('connect.checkAgents', target, LONG_REQUEST))
  if (mine !== runs) return
  const kept = read(form)
  if (formOpens({ ...checks, agents }) && (kept === null || kept.project !== project.id)) {
    set(form, { project: project.id, values: initialForm(git.result, agents) })
    set(fieldErrors, [])
  }
  show({ ...checks, agents })
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

function initialForm(git: GitCheck, agents: CheckState<AgentsCheck>): FormState {
  const known = knownAgents(agents)
  const defaults = agents.state === 'done' && 'defaults' in agents.result ? agents.result.defaults : null
  const pick = (role: Role) => {
    const id = defaults?.[role]
    return id !== undefined && known.some((agent) => agent.id === id) ? id : null
  }
  return {
    baseBranch: git.status === 'ok' ? git.defaultBranch : '',
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
  const current = read(form)
  if (current === null) return
  set(form, { project: current.project, values: change(current.values) })
  if (field !== null) set(fieldErrors, read(fieldErrors).filter((error) => error.field !== field))
}

/** «Подключить» (and «Повторить» after a rejected push): the worker checks everything again and connects. */
async function submit(): Promise<void> {
  const current = read(wizard)
  const filled = read(form)
  if (current.step === 'choose' || filled === null) return
  const checks: Checks = { project: current.project, git: current.git, gh: current.gh, agents: current.agents }
  const mine = ++runs
  set(wizard, { step: 'connecting', ...checks })
  let result: ConnectResult
  try {
    result = await plugin.request('connect.connect', {
      projectId: checks.project.id,
      hostId: checks.project.hostId,
      form: formToSend(filled.values),
    }, LONG_REQUEST)
  } catch (error) {
    result = { status: 'failed', error: errorMessage(error), operation: '' }
  }
  if (mine !== runs) return
  if (result.status === 'connected') {
    set(selectedProject, result.project.id)
    void connectedProjects.load()
    set(wizard, { step: 'choose' })
    set(form, null)
    openScreen('doctor')
    return
  }
  if (result.status === 'fields') {
    set(fieldErrors, result.errors)
    set(wizard, { step: 'checks', ...checks })
    return
  }
  const outcome: Outcome =
    result.status === 'refused'
      ? { kind: 'refused', refusal: result.refusal }
      : result.status === 'pushRejected'
        ? { kind: 'pushRejected', error: result.error }
        : { kind: 'failed', error: result.error }
  set(wizard, { step: 'outcome', outcome, ...checks })
}

// ── Drawing ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export function ConnectScreen() {
  const current = read(wizard)
  return <ScreenFrame screen="connect">{current.step === 'choose' ? <ChooseStep /> : <ProjectSteps wizard={current} />}</ScreenFrame>
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
                <Button key={`choose:${project.id}`} size="sm" disabled={project.kit} onPress={() => void runChecks(project)}>
                  {t('connect.choose')}
                </Button>
              </Row>
              <Text muted size="sm">
                {project.kit
                  ? t('connect.kit')
                  : project.repository === null
                    ? t('connect.candidateNoGithub', { path: project.path })
                    : t('connect.candidateGithub', { path: project.path, repository: project.repository })}
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

function gitLine(git: CheckState<GitCheck>): Line {
  if (git.state === 'waiting' || git.state === 'running') return { key: 'git', status: 'running', text: t('connect.gitChecking') }
  if (git.state === 'error') return { key: 'git', status: 'problem', text: t('connect.gitUnchecked', { error: git.error }) }
  const result = git.result
  if (result.status === 'ok') return { key: 'git', status: 'ok', text: t('connect.gitOk', { repository: result.repository }) }
  if (result.status === 'unchecked') return { key: 'git', status: 'problem', text: t('connect.gitUnchecked', { error: result.error }) }
  const texts = { 'not-git': 'connect.notGit', 'no-github': 'connect.noGithub', 'no-branches': 'connect.noBranches' } as const
  return { key: 'git', status: 'problem', text: t(texts[result.problem]) }
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

function agentsLine(agents: CheckState<AgentsCheck>): Line {
  if (agents.state === 'waiting') return { key: 'agents', status: 'waiting', text: t('connect.agentsWaiting') }
  if (agents.state === 'running') return { key: 'agents', status: 'running', text: t('connect.agentsChecking') }
  if (agents.state === 'error') return { key: 'agents', status: 'problem', text: t('connect.agentsUnchecked', { reason: agents.error }) }
  const result = agents.result
  if (result.status === 'ok') {
    return { key: 'agents', status: 'ok', text: t('connect.agentsOk', { agents: uniqueRoles(result.defaults).join(', ') }) }
  }
  if (result.status === 'unchecked') {
    const key = result.kind === 'cli-not-found' ? 'connect.agentsNoCli' : 'connect.agentsUnchecked'
    return { key: 'agents', status: 'problem', text: t(key, { reason: result.reason }) }
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
  const repository = gitOk && git.state === 'done' && git.result.status === 'ok' ? git.result.repository : (checks.project.repository ?? '')
  const lines = [gitLine(git), ...(gitOk ? [ghLine(checks.gh, repository), agentsLine(checks.agents)] : [])]
  const opens = formOpens(checks)
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
  branch: 'connect.errorBranch',
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
  const git = props.checks.git
  const branches = git.state === 'done' && git.result.status === 'ok' ? git.result.branches : []
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
        onChange={(value) => changeForm(field, (current) => ({ ...current, [field]: value }))}
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
          onChange={(value) => changeForm('baseBranch', (current) => ({ ...current, baseBranch: value }))}
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
            onChange={(value) => changeForm(`agents.${role}`, (current) => ({ ...current, agents: { ...current.agents, [role]: value } }))}
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
          onChange={(value) => changeForm('language', (current) => ({ ...current, language: value === 'ru' ? 'ru' : 'en' }))}
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
          onChange={(value) => changeForm('worktreeMode', (current) => ({ ...current, worktreeMode: value === 'own' ? 'own' : 'shared' }))}
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
          onChange={(value) => changeForm('dataRule', (current) => ({ ...current, dataRule: value }))}
        />
      </Field>
      <Field label={t('connect.taskRules')} error={errorOf('taskRules')} required>
        <Textarea
          label={t('connect.taskRules')}
          labelHidden
          rows={8}
          value={shownTaskRules(values)}
          invalid={errorOf('taskRules') !== undefined}
          onChange={(value) => changeForm('taskRules', (current) => ({ ...current, taskRules: value }))}
        />
      </Field>
      <Row>
        <Button tone="accent" variant="solid" disabled={errors.length > 0} onPress={() => void submit()}>
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
  const message =
    outcome.kind === 'pushRejected' ? t('connect.pushRejected', { error: outcome.error }) : t('connect.failed', { error: outcome.error })
  return (
    <Callout tone="danger">
      <Stack gap="sm">
        <Text>{message}</Text>
        <Row>
          <Button tone="accent" icon="refresh" onPress={() => void submit()}>
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
    case 'busy':
      return t('connect.busy')
    case 'git':
      return gitLine({ state: 'done', result: refusal.check }).text
    case 'gh':
      return ghLine({ state: 'done', result: refusal.check }, repository).text
    case 'agents':
      return refusal.check.status === 'unchecked'
        ? t('connect.agentsRefused', { reason: refusal.check.reason })
        : agentsLine({ state: 'done', result: refusal.check }).text
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
    case 'file':
      return t('connect.fileRefused', { file: refusal.file, problem: refusal.problem })
    case 'journal':
      return t('connect.journalRefused', { error: refusal.error })
  }
}
