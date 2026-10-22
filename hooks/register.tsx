import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Project, Status } from '../types'

const PANE = 'checklist'
const TITLE = 'Checklist'
const TOOL = 'mcp__checklist__checklist'
const USAGE =
  '/checklist [add <title> [-- detail] | done|open|drop <id> | edit <id> <title> | remove <id> | clear | close | version]'

const list = atom({ plugin: 'checklist', key: 'list' } as const, { project: '', root: '', items: [] as Item[] })

const MARK: Record<Status, string> = { open: '[ ]', done: '[x]', dropped: '[-]', removed: '[~]' }
const VERB: Partial<Record<string, Status>> = { done: 'done', open: 'open', drop: 'dropped' }

/**
 * The key one project's list is stored under: its git root, else the session's root.
 * Worked out once per session root and kept, since `$.session.repo()` reads the
 * shell's directory and a `cd` there would move the list; a `/cd` moves the root.
 */
async function projectKey($: EngineInterface): Promise<string> {
  const root = await $.session.root()
  const kept = await read($, list)
  if (kept.project && kept.root === root) return kept.project
  const repo = await $.session.repo()
  const project = repo?.root ?? root
  const data = await load($, project)
  await update($, list, () => ({ project, root, items: data.items }))
  return project
}

async function load($: EngineInterface, project: string): Promise<Project> {
  const saved = (await $.store.get(`project:${project}`)) as Project | undefined
  return saved && Array.isArray(saved.items) ? { items: saved.items } : { items: [] }
}

async function save($: EngineInterface, project: string, data: Project): Promise<void> {
  await $.store.set(`project:${project}`, data)
  // A click on a pane drawn before a /cd saves the project it shows, not the one now kept.
  await update($, list, state => (state.project === project ? { ...state, items: data.items } : state))
}

const label = (item: Item) => `${item.id}. ${item.title}`

/** The lowest id no item holds: a removed item's id goes back to the pool. */
function freeId(items: Item[]): number {
  const held = new Set(items.map(i => i.id))
  let id = 1
  while (held.has(String(id))) id++
  return id
}

/** A click on a row: open becomes done, done and dropped become open. */
const toggled = (status: Status): Status => (status === 'open' ? 'done' : 'open')

// One change to a project's list, as the command, the tool and a click ask for it.
type Op =
  | { kind: 'add'; title: string; detail?: string }
  | { kind: 'status'; id: string; status: Status }
  | { kind: 'edit'; id: string; title: string }
  | { kind: 'remove'; id: string }
  | { kind: 'clear' }

type Outcome = { ok: boolean; text: string; items: Item[] }

async function apply($: EngineInterface, project: string, op: Op): Promise<Outcome> {
  const data = await load($, project)
  const fail = (text: string): Outcome => ({ ok: false, text, items: data.items })
  const item = 'id' in op ? data.items.find(i => i.id === op.id) : undefined

  switch (op.kind) {
    case 'add': {
      const title = op.title.trim()
      if (!title) return fail('A title is needed.')
      const detail = op.detail?.trim()
      const added: Item = { id: String(freeId(data.items)), title, status: 'open', ...(detail ? { detail } : {}) }
      const items = [...data.items, added].sort((a, b) => Number(a.id) - Number(b.id))
      await save($, project, { items })
      return { ok: true, text: `Added ${label(added)}`, items }
    }
    case 'status': {
      if (!item) return fail(`No item ${op.id}.`)
      const items = data.items.map(i => (i === item ? { ...i, status: op.status } : i))
      await save($, project, { ...data, items })
      return { ok: true, text: `${label(item)} is now ${op.status}.`, items }
    }
    case 'edit': {
      const title = op.title.trim()
      if (!item) return fail(`No item ${op.id}.`)
      if (!title) return fail('A title is needed.')
      const items = data.items.map(i => (i === item ? { ...i, title } : i))
      await save($, project, { ...data, items })
      return { ok: true, text: `${item.id}. ${title} (was: ${item.title})`, items }
    }
    case 'remove': {
      if (!item) return fail(`No item ${op.id}.`)
      // Kept under its number, struck through, so the numbers never skip.
      const items = data.items.map(i => (i === item ? { ...i, status: 'removed' as const } : i))
      await save($, project, { ...data, items })
      return { ok: true, text: `Removed ${label(item)}`, items }
    }
    case 'clear': {
      await save($, project, { items: [] })
      const removed = data.items.map(label)
      return {
        ok: true,
        items: [],
        text: removed.length
          ? `Cleared ${removed.length} item${removed.length === 1 ? '' : 's'}: ${removed.join('; ')}`
          : 'The checklist was already empty.',
      }
    }
  }
}

/** A tool call's row, in a line: the action and what it names, never the detail. */
function callLine(input: Record<string, unknown>): string {
  const id = input.id === undefined ? '' : ` ${String(input.id)}`
  const title = input.title === undefined ? '' : ` "${String(input.title)}"`
  return `Checklist · ${String(input.action ?? '')}${id}${title}`
}

/**
 * A tool answer in a line: its first, or a count when it is a list alone.
 * Undefined for an answer in no shape this tool gives, which the engine draws.
 */
function resultLine(output: unknown): string | undefined {
  if (typeof output !== 'string' || !output) return undefined
  const lines = output.split('\n')
  const marks = Object.values(MARK)
  if (!marks.some(m => lines[0].startsWith(`${m} `))) return lines[0]
  const kept = lines.filter(l => !l.startsWith(`${MARK.removed} `)).length
  const open = lines.filter(l => l.startsWith(`${MARK.open} `)).length
  return `${kept} item${kept === 1 ? '' : 's'}, ${open} open`
}

const summary = (items: Item[]) =>
  items.length === 0
    ? 'The checklist is empty.'
    : items.map(i => `${MARK[i.status]} ${label(i)}${i.detail ? ` -- ${i.detail}` : ''}`).join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'checklist',
      description: 'Per-project checklist pane: add, edit, done|open|drop, remove, clear, close, version',
    })
    await $.tool.register({
      name: 'checklist',
      isDeferred: false,
      description:
        "The project's checklist, shown in a pane beside the chat and kept per project across sessions. " +
        'Use it to record tasks the user agrees on, mark them done as you finish them, or read what is open. ' +
        'Actions: list; add (title, optional detail); done, open, drop, remove (id); edit (id, title); clear. ' +
        'remove keeps the item under its number, struck through, and open brings it back; clear empties the list. ' +
        'Each answer ends with the whole list, one item per line as [ ] open, [x] done, [-] dropped, [~] removed.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'done', 'open', 'drop', 'edit', 'remove', 'clear'] },
          id: { type: 'string', description: 'The item number, for done, open, drop, edit and remove' },
          title: { type: 'string', description: 'The title, for add and edit' },
          detail: { type: 'string', description: 'One line of detail, for add' },
        },
        required: ['action'],
      },
    })
    const project = await projectKey($)
    const data = await load($, project)
    await update($, list, state => ({ ...state, items: data.items }))
    // Open unasked only when there is something to show.
    if (data.items.length > 0) void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const action = String(e.action ?? '')
    const id = String(e.id ?? '').trim()
    const title = String(e.title ?? '')
    const detail = e.detail === undefined ? undefined : String(e.detail)
    const project = await projectKey($)
    const status = VERB[action]

    const op: Op | undefined =
      action === 'add' ? { kind: 'add', title, detail }
      : status ? { kind: 'status', id, status }
      : action === 'edit' ? { kind: 'edit', id, title }
      : action === 'remove' ? { kind: 'remove', id }
      : action === 'clear' ? { kind: 'clear' }
      : undefined

    if (action === 'list') {
      const data = await load($, project)
      return { result: summary(data.items) }
    }
    if (!op) return { deny: `Unknown action "${action}". ${USAGE}` }
    const out = await apply($, project, op)
    if (!out.ok) return { deny: out.text }
    if (out.items.length > 0) void $.ui.open({ id: PANE, title: TITLE })
    return { result: `${out.text}\n${summary(out.items)}` }
  })

  on('command.run', { command: 'checklist' }, async ($, e) => {
    const args = e.args.trim()
    if (!args) {
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: `Checklist pane opened. ${USAGE}` }
    }

    const [verb, ...rest] = args.split(/\s+/)
    if (verb === 'close' && rest.length === 0) {
      await $.ui.close({ id: PANE })
      return { text: 'Checklist pane closed. /checklist reopens it.' }
    }
    if (verb === 'version' && rest.length === 0) {
      const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
      return { text: `${$.plugin.name} ${manifest.version ?? '(no version in plugin.json)'}` }
    }

    const status = VERB[verb]
    const id = (rest[0] ?? '').toLowerCase()
    let op: Op | undefined
    if (verb === 'add') {
      const body = args.slice(verb.length).trim()
      const [rawTitle, ...detailParts] = body.split(/\s+--\s+|^--\s+|\s+--$/)
      const title = (rawTitle ?? '').trim()
      if (title) op = { kind: 'add', title, detail: detailParts.join(' -- ') }
    } else if (status && rest.length === 1) {
      op = { kind: 'status', id, status }
    } else if (verb === 'edit' && rest.length >= 2) {
      op = { kind: 'edit', id, title: rest.slice(1).join(' ') }
    } else if (verb === 'remove' && rest.length === 1) {
      op = { kind: 'remove', id }
    } else if (verb === 'clear' && rest.length === 0) {
      op = { kind: 'clear' }
    }
    if (!op) return { text: USAGE }

    const out = await apply($, await projectKey($), op)
    if (!out.ok) return { text: USAGE }
    if (op.kind !== 'clear') await $.ui.open({ id: PANE, title: TITLE })
    return { text: out.text }
  })

  // Claude's calls to the tool, one line each in the transcript; ctrl+o shows them whole.
  on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e, next) => {
    if (e.props.isExpanded || typeof e.props.input !== 'object' || e.props.input === null) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor={e.props.isRunning}>{callLine(e.props.input as Record<string, unknown>)}</Text>
  })

  on('ui.render', { component: 'ToolResult', props: { tool: TOOL } }, async ($, e, next) => {
    const line = resultLine(e.props.output)
    if (e.props.isExpanded || e.props.isErrored || line === undefined) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box paddingLeft={2}>
        <Text dimColor>{line}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { project, items } = await read($, list)
    const wide = e.props.bodyColumns >= 56
    const open = items.filter(i => i.status === 'open').length
    // The header counts what is on the list; removed items stand only to keep the numbers.
    const kept = items.filter(i => i.status !== 'removed').length

    return (
      <Box flexDirection="column">
        <Text bold>{open} open of {kept}</Text>
        {items.length === 0 && <Text dimColor>Nothing yet. /checklist add &lt;title&gt; [-- detail]</Text>}
        {items.map(item => {
          const isOpen = item.status === 'open'
          // A removed item is no row to click: /checklist open <id> brings it back.
          if (item.status === 'removed')
            return (
              <Text key={item.id} dimColor>
                {MARK.removed}{' '}
                <Text dimColor strikethrough>
                  {label(item)}
                </Text>
              </Text>
            )
          return (
            <Box key={item.id} flexDirection="column">
              <Button
                key={`item:${item.id}`}
                plain
                dimColor={!isOpen}
                onPress={() => void apply($, project, { kind: 'status', id: item.id, status: toggled(item.status) })}
              >
                {MARK[item.status]}{' '}
                <Text bold={isOpen} dimColor={!isOpen} strikethrough={item.status === 'dropped'}>
                  {label(item)}
                </Text>
              </Button>
              {wide && item.detail && <Text dimColor>      {item.detail}</Text>}
            </Box>
          )
        })}
      </Box>
    )
  })
}
