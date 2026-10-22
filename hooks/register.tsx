import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Project, Status } from '../types'

const PANE = 'checklist'
const TITLE = 'Checklist'
const TOOL = 'mcp__checklist__checklist'
const USAGE =
  '/checklist [add <title> [-- detail] | done|open|drop <n> | edit <n> <title> | remove <n> | clear | close | version]'

const list = atom({ plugin: 'checklist', key: 'list' } as const, { project: '', root: '', items: [] as Item[] })

const MARK: Record<Status, string> = { open: '[ ]', done: '[x]', dropped: '[-]' }
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

// A list saved before uids: each item's number was its id, and a removed one ([~]) stayed on the list.
type Saved = { next?: number; items?: Array<Partial<Item> & { id?: string; status?: string }> }

async function load($: EngineInterface, project: string): Promise<Project> {
  const saved = (await $.store.get(`project:${project}`)) as Saved | undefined
  if (!saved || !Array.isArray(saved.items)) return { next: 1, items: [] }
  // An older list keeps each item's number as its uid and lets its removed items go.
  const items: Item[] = saved.items
    .filter(i => i.status !== 'removed')
    .map(({ id, ...i }) => ({ ...i, uid: i.uid ?? Number(id) }) as Item)
  const next = Math.max(saved.next ?? 1, ...items.map(i => i.uid + 1))
  return { next, items }
}

async function save($: EngineInterface, project: string, data: Project): Promise<void> {
  await $.store.set(`project:${project}`, data)
  // A click on a pane drawn before a /cd saves the project it shows, not the one now kept.
  await update($, list, state => (state.project === project ? { ...state, items: data.items } : state))
}

/**
 * An item as each reader names it: the person by position alone, Claude by
 * position and uid, so Claude can keep naming it after the positions move.
 */
const label = (item: Item, position: number, forModel: boolean) =>
  `${position}. ${item.title}${forModel ? ` (#${item.uid})` : ''}`

/** A click on a row: open becomes done, done and dropped become open. */
const toggled = (status: Status): Status => (status === 'open' ? 'done' : 'open')

/** Which item a change names: by position in the list now, or by uid. */
type Ref = { position: number } | { uid: number }

// One change to a project's list, as the command, the tool and a click ask for it.
type Op =
  | { kind: 'add'; title: string; detail?: string }
  | { kind: 'status'; ref: Ref; status: Status }
  | { kind: 'edit'; ref: Ref; title: string }
  | { kind: 'remove'; ref: Ref }
  | { kind: 'clear' }

type Outcome = { ok: boolean; text: string; items: Item[] }

async function apply($: EngineInterface, project: string, op: Op, forModel = false): Promise<Outcome> {
  const data = await load($, project)
  const fail = (text: string): Outcome => ({ ok: false, text, items: data.items })
  const at =
    'ref' in op
      ? 'uid' in op.ref
        ? data.items.findIndex(i => i.uid === (op.ref as { uid: number }).uid)
        : op.ref.position - 1
      : -1
  const item = data.items[at]
  const named = (i: Item) => label(i, at + 1, forModel)
  const missing = () =>
    fail('ref' in op && 'uid' in op.ref ? `No item #${op.ref.uid}.` : `No item at position ${at + 1}.`)

  switch (op.kind) {
    case 'add': {
      const title = op.title.trim()
      if (!title) return fail('A title is needed.')
      const detail = op.detail?.trim()
      const added: Item = { uid: data.next, title, status: 'open', ...(detail ? { detail } : {}) }
      const items = [...data.items, added]
      await save($, project, { next: data.next + 1, items })
      return { ok: true, text: `Added ${label(added, items.length, forModel)}`, items }
    }
    case 'status': {
      if (!item) return missing()
      const items = data.items.map(i => (i === item ? { ...i, status: op.status } : i))
      await save($, project, { ...data, items })
      return { ok: true, text: `${named(item)} is now ${op.status}.`, items }
    }
    case 'edit': {
      const title = op.title.trim()
      if (!item) return missing()
      if (!title) return fail('A title is needed.')
      const items = data.items.map(i => (i === item ? { ...i, title } : i))
      await save($, project, { ...data, items })
      return { ok: true, text: `${named({ ...item, title })} (was: ${item.title})`, items }
    }
    case 'remove': {
      if (!item) return missing()
      // Gone from the list: the items after it move up a place, and keep their uids.
      const items = data.items.filter(i => i !== item)
      await save($, project, { ...data, items })
      const moved = forModel && at < items.length ? '; the items after it moved up one place' : ''
      return { ok: true, text: `Removed ${named(item)}${moved}`, items }
    }
    case 'clear': {
      // Positions start again from 1; uids carry on, so an old one never names a new item.
      await save($, project, { ...data, items: [] })
      const removed = data.items.map((i, n) => label(i, n + 1, forModel))
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

/** A uid as Claude writes it: `12` or `#12`. */
const uidOf = (value: unknown) => {
  const text = String(value).trim().replace(/^#/, '')
  return /^\d+$/.test(text) ? Number(text) : undefined
}

/** A position as typed or sent: a whole number from 1. */
const positionOf = (value: unknown) => {
  const text = String(value).trim()
  return /^\d+$/.test(text) && Number(text) >= 1 ? Number(text) : undefined
}

/** A tool call's row, in a line: the action and what it names, never a uid or the detail. */
function callLine(input: Record<string, unknown>, items: Item[]): string {
  const uid = input.id === undefined ? undefined : uidOf(input.id)
  const known = uid === undefined ? undefined : items.find(i => i.uid === uid)
  const which =
    input.title !== undefined ? ` "${String(input.title)}"`
    : known ? ` "${known.title}"`
    : input.position !== undefined ? ` ${String(input.position)}`
    : ''
  return `Checklist · ${String(input.action ?? '')}${which}`
}

/**
 * A tool answer in a line, uids left out: its first, or a count when it is a list.
 * Undefined for an answer in no shape this tool gives, which the engine draws.
 */
function resultLine(output: unknown): string | undefined {
  if (typeof output !== 'string' || !output) return undefined
  const lines = output.split('\n')
  if (!Object.values(MARK).some(m => lines[0].startsWith(`${m} `)))
    return lines[0].replace(/ \(#\d+\)/g, '').replace(/; the items after it moved up one place$/, '')
  const open = lines.filter(l => l.startsWith(`${MARK.open} `)).length
  return `${lines.length} item${lines.length === 1 ? '' : 's'}, ${open} open`
}

/** The whole list as Claude reads it: mark, position, title, uid, detail. */
const summary = (items: Item[]) =>
  items.length === 0
    ? 'The checklist is empty.'
    : items.map((i, n) => `${MARK[i.status]} ${label(i, n + 1, true)}${i.detail ? ` -- ${i.detail}` : ''}`).join('\n')

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
        'The user sees items by position (1, 2, 3, with no gaps: a removed item is gone and the ones after it ' +
        'move up). You also see each item\'s id (#12), which never changes and is never reused. ' +
        'Name an item by id when you are tracking it yourself; by position when you repeat a number the user ' +
        'gave, since a position is read against the list as it stands now, which is what the user sees. ' +
        'Actions: list; add (title, optional detail); done, open, drop, remove (id or position); ' +
        'edit (id or position, title); clear. A change answers with the one item it touched; list answers with ' +
        'every item, one per line: [ ] open, [x] done or [-] dropped, then position, title, (#id) and any detail.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'done', 'open', 'drop', 'edit', 'remove', 'clear'] },
          id: { type: 'string', description: "The item's id, as #12 or 12; give this or position" },
          position: { type: 'integer', minimum: 1, description: "The item's place in the list now, from 1" },
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
    const title = String(e.title ?? '')
    const detail = e.detail === undefined ? undefined : String(e.detail)
    const project = await projectKey($)
    const status = VERB[action]

    if (action === 'list') return { result: summary((await load($, project)).items) }
    if (action === 'add') return answer(await apply($, project, { kind: 'add', title, detail }, true))
    if (action === 'clear') return answer(await apply($, project, { kind: 'clear' }, true))
    if (!status && action !== 'edit' && action !== 'remove') return { deny: `Unknown action "${action}". ${USAGE}` }

    // Every other action names one item, by id or by position.
    const hasId = e.id !== undefined && e.id !== ''
    const hasPosition = e.position !== undefined && e.position !== ''
    if (hasId === hasPosition) return { deny: 'Name the item by id or by position: one of them.' }
    const uid = hasId ? uidOf(e.id) : undefined
    const position = hasPosition ? positionOf(e.position) : undefined
    if (hasId && uid === undefined) return { deny: `"${String(e.id)}" is no id: an id is a number, as #12.` }
    if (hasPosition && position === undefined) return { deny: `"${String(e.position)}" is no position: 1 or more.` }
    const ref: Ref = uid !== undefined ? { uid } : { position: position! }

    const op: Op =
      status ? { kind: 'status', ref, status }
      : action === 'edit' ? { kind: 'edit', ref, title }
      : { kind: 'remove', ref }
    return answer(await apply($, project, op, true))

    function answer(out: Outcome) {
      if (!out.ok) return { deny: out.text }
      if (out.items.length > 0) void $.ui.open({ id: PANE, title: TITLE })
      return { result: out.text }
    }
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

    // The person names an item by its position, as the pane shows it.
    const status = VERB[verb]
    const position = rest[0] === undefined ? undefined : positionOf(rest[0])
    const ref: Ref | undefined = position === undefined ? undefined : { position }
    let op: Op | undefined
    if (verb === 'add') {
      const body = args.slice(verb.length).trim()
      const [rawTitle, ...detailParts] = body.split(/\s+--\s+|^--\s+|\s+--$/)
      const title = (rawTitle ?? '').trim()
      if (title) op = { kind: 'add', title, detail: detailParts.join(' -- ') }
    } else if (status && ref && rest.length === 1) {
      op = { kind: 'status', ref, status }
    } else if (verb === 'edit' && ref && rest.length >= 2) {
      op = { kind: 'edit', ref, title: rest.slice(1).join(' ') }
    } else if (verb === 'remove' && ref && rest.length === 1) {
      op = { kind: 'remove', ref }
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
    const { items } = await read($, list)
    return <Text dimColor={e.props.isRunning}>{callLine(e.props.input as Record<string, unknown>, items)}</Text>
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

    return (
      <Box flexDirection="column">
        <Text bold>{open} open of {items.length}</Text>
        {items.length === 0 && <Text dimColor>Nothing yet. /checklist add &lt;title&gt; [-- detail]</Text>}
        {items.map((item, n) => {
          const isOpen = item.status === 'open'
          return (
            <Box key={item.uid} flexDirection="column">
              <Button
                key={`item:${item.uid}`}
                plain
                dimColor={!isOpen}
                // By uid: a click toggles the row it was drawn for, whatever has moved since.
                onPress={() =>
                  void apply($, project, { kind: 'status', ref: { uid: item.uid }, status: toggled(item.status) })
                }
              >
                {MARK[item.status]}{' '}
                <Text bold={isOpen} dimColor={!isOpen} strikethrough={item.status === 'dropped'}>
                  {label(item, n + 1, false)}
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
