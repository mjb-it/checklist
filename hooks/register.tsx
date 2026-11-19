import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, List, Lists, Status } from '../types'

const PANE = 'checklist'
const TITLE = 'Checklist'
const TOOL = 'mcp__checklist__checklist'
const USAGE =
  '/checklist [@list] [add <title> [-- detail] | done|open|drop <n> | edit <n> <title> | move <n> to [@list] [<m>] | remove <n> | clear] | close | version'

/** The list an item goes to when the session has none yet. */
const FIRST = 'main'

const live = atom(
  { plugin: 'checklist', key: 'list' } as const,
  { key: '', carry: false, current: '', lists: [] as List[] },
  { shape: 'lists-1' },
)

/** A session's lists not touched for this long are let go at the next session start. */
const KEEP_MS = 90 * 24 * 60 * 60 * 1000

const MARK: Record<Status, string> = { open: '[ ]', done: '[x]', dropped: '[-]' }
const VERB: Partial<Record<string, Status>> = { done: 'done', open: 'open', drop: 'dropped' }

/**
 * The key this session's lists are stored under: its session id, so no other
 * session sees them. The id changes under a running process on /clear, which
 * carries the lists over, and on a switch to another session, which brings
 * that session's own; either way the live lists follow here.
 */
async function sessionKey($: EngineInterface): Promise<string> {
  const key = `session:${await $.session.id()}`
  const kept = await read($, live)
  if (kept.key === key) return key
  if (kept.key && kept.carry && (await $.store.get(key)) === undefined) {
    await $.store.set(key, await $.store.get(kept.key))
    await $.store.delete(kept.key)
  }
  const { current, lists } = await load($, key)
  await update($, live, () => ({ key, carry: false, current, lists }))
  return key
}

/**
 * Lists were kept per project before they were kept per session: the first
 * session to start in a project takes that project's list as its own, once.
 */
async function claimProjectList($: EngineInterface, key: string, now: number): Promise<void> {
  if ((await $.store.get(key)) !== undefined) return
  const project = `project:${(await $.session.repo())?.root ?? (await $.session.root())}`
  const saved = await $.store.get(project)
  if (saved === undefined) return
  await $.store.set(key, { ...(saved as object), touched: now })
  await $.store.delete(project)
}

/** Lets go of every session's lists no session has touched for KEEP_MS. */
async function prune($: EngineInterface, now: number): Promise<void> {
  for (const key of await $.store.keys()) {
    if (!key.startsWith('session:')) continue
    const saved = (await $.store.get(key)) as { touched?: number } | undefined
    if (now - (saved?.touched ?? 0) > KEEP_MS) await $.store.delete(key)
  }
}

// Saved before uids, an item's number was its id, and a removed one ([~]) stayed on the list.
type SavedItem = Omit<Partial<Item>, 'status'> & { id?: string; status?: string }
// Saved before named lists, a session had one list: `items` alone.
type Saved = { next?: number; current?: string; items?: SavedItem[]; lists?: Array<{ name?: string; items?: SavedItem[] }> }

const tidy = (items: SavedItem[]): Item[] =>
  items.filter(i => i.status !== 'removed').map(({ id, ...i }) => ({ ...i, uid: i.uid ?? Number(id) }) as Item)

/** Keeps the lists that hold items, and a current list that is one of them. */
function settled(data: Lists): Lists {
  const lists = data.lists.filter(l => l.items.length > 0)
  const current = lists.some(l => l.name === data.current) ? data.current : (lists[0]?.name ?? '')
  return { next: data.next, current, lists }
}

async function load($: EngineInterface, key: string): Promise<Lists> {
  const saved = (await $.store.get(key)) as Saved | undefined
  const lists: List[] =
    Array.isArray(saved?.lists) ? saved.lists.map(l => ({ name: String(l.name ?? FIRST), items: tidy(l.items ?? []) }))
    : Array.isArray(saved?.items) ? [{ name: FIRST, items: tidy(saved.items) }]
    : []
  const next = Math.max(saved?.next ?? 1, ...lists.flatMap(l => l.items.map(i => i.uid + 1)))
  return settled({ next, current: saved?.current ?? '', lists })
}

async function save($: EngineInterface, key: string, data: Lists): Promise<Lists> {
  const kept = settled(data)
  await $.store.set(key, { ...kept, touched: await $.clock.now() })
  // A click on a pane drawn before the session changed saves the lists it shows, not the ones now kept.
  await update($, live, state => (state.key === key ? { ...state, current: kept.current, lists: kept.lists } : state))
  return kept
}

/**
 * A list's name as typed or sent: `@chores`, `Chores` and `chores` are one
 * list; spaces become dashes. A number alone is no name, since it reads as a position.
 */
function nameOf(value: unknown): string | undefined {
  const text = String(value ?? '').trim().replace(/^@/, '').toLowerCase().replace(/\s+/g, '-')
  return /^[a-z0-9_-]{1,40}$/.test(text) && !/^\d+$/.test(text) ? text : undefined
}

/** Whether the person can see the pane now: open, drawn, and the tab in front. */
async function paneShown($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced && p.isShown)
}

/** Which item a change names: by position in a list now, or by uid. */
type Ref = { position: number } | { uid: number }

// One change to the session's lists, as the command, the tool and a click ask for it.
// `list` names the list an add, a clear or a position is in, and makes it current.
type Op = { list?: string } & (
  | { kind: 'add'; title: string; detail?: string }
  | { kind: 'status'; ref: Ref; status: Status }
  | { kind: 'edit'; ref: Ref; title: string }
  | { kind: 'move'; ref: Ref; to?: number; into?: string }
  | { kind: 'remove'; ref: Ref }
  | { kind: 'clear' }
  | { kind: 'use' }
)

/** `ask`: no list was named, there are several, and the pane that shows the current one is closed. */
type Outcome = { ok: boolean; text: string; lists: List[]; ask?: boolean }

const names = (lists: List[]) => lists.map(l => l.name).join(', ')

async function apply($: EngineInterface, key: string, op: Op, forModel = false): Promise<Outcome> {
  const data = await load($, key)
  const fail = (text: string, ask = false): Outcome => ({ ok: false, text, lists: data.lists, ask })
  const byUid = 'ref' in op && 'uid' in op.ref ? op.ref.uid : undefined

  // The list the change is in: the one holding the uid, the one named, or the current one.
  let name: string
  if (byUid !== undefined) {
    const holder = data.lists.find(l => l.items.some(i => i.uid === byUid))
    if (!holder) return fail(`No item #${byUid}.`)
    name = holder.name
  } else if (op.list !== undefined) {
    name = op.list
  } else {
    // A bare position or add means the list on screen; with the pane closed, which one that is goes unseen.
    if (data.lists.length > 1 && !(await paneShown($))) return fail(`Which list: ${names(data.lists)}?`, true)
    name = data.current || FIRST
  }
  let list = data.lists.find(l => l.name === name)
  if (!list) {
    if (data.lists.length > 0 && op.kind !== 'add') return fail(`No list "${name}". The lists: ${names(data.lists)}.`)
    if (op.kind === 'clear') return { ok: true, text: 'The checklist was already empty.', lists: [] }
    if (op.kind === 'use') return fail('The checklist is empty.')
    // With no lists yet, an add makes one; a position names nothing, below.
    list = { name, items: [] }
    data.lists = [...data.lists, list]
  }
  const current = op.list !== undefined || op.kind === 'add' ? name : data.current

  // Positions name their list, once there is more than one to tell apart.
  const many = () => data.lists.length > 1 || op.list !== undefined
  const where = (listName: string) => (many() ? `${listName} ` : '')
  const label = (item: Item, position: number, listName = name) =>
    `${where(listName)}${position}. ${item.title}${forModel ? ` (#${item.uid})` : ''}`
  const at =
    byUid !== undefined ? list.items.findIndex(i => i.uid === byUid)
    : 'ref' in op && 'position' in op.ref ? op.ref.position - 1
    : -1
  const item = list.items[at]
  const named = (i: Item) => label(i, at + 1)
  const missing = () => fail(`No item at position ${at + 1}${many() ? ` in ${name}` : ''}.`)
  const store = async (lists: List[], next = data.next) => (await save($, key, { next, current, lists })).lists
  const replaced = (items: Item[]) => data.lists.map(l => (l === list ? { ...l, items } : l))

  switch (op.kind) {
    case 'add': {
      const title = op.title.trim()
      if (!title) return fail('A title is needed.')
      const detail = op.detail?.trim()
      const added: Item = { uid: data.next, title, status: 'open', ...(detail ? { detail } : {}) }
      const items = [...list.items, added]
      const lists = await store(replaced(items), data.next + 1)
      return { ok: true, text: `Added ${label(added, items.length)}`, lists }
    }
    case 'status': {
      if (!item) return missing()
      const lists = await store(replaced(list.items.map(i => (i === item ? { ...i, status: op.status } : i))))
      return { ok: true, text: `${named(item)} is now ${op.status}.`, lists }
    }
    case 'edit': {
      const title = op.title.trim()
      if (!item) return missing()
      if (!title) return fail('A title is needed.')
      const lists = await store(replaced(list.items.map(i => (i === item ? { ...i, title } : i))))
      return { ok: true, text: `${named({ ...item, title })} (was: ${item.title})`, lists }
    }
    case 'move': {
      if (!item) return missing()
      const into = op.into ?? name
      if (into === name) {
        if (op.to === undefined) return fail('A place to move to is needed.')
        if (op.to > list.items.length) return fail(`No position ${op.to}: ${where(name)}the list has ${list.items.length}.`)
        // It lands at the place asked for; the items between shift one place to make room.
        const items = list.items.filter(i => i !== item)
        items.splice(op.to - 1, 0, item)
        if (op.to - 1 === at) return { ok: true, text: `${named(item)} is already there.`, lists: data.lists }
        const lists = await store(replaced(items))
        return { ok: true, text: `Moved ${label(item, op.to)} (was ${at + 1})`, lists }
      }
      // To another list: last unless a place is asked for, and the list is made if it is new.
      const target = data.lists.find(l => l.name === into) ?? { name: into, items: [] }
      const to = op.to ?? target.items.length + 1
      if (to > target.items.length + 1) return fail(`No position ${to}: ${into} has ${target.items.length}.`)
      const targetItems = [...target.items]
      targetItems.splice(to - 1, 0, item)
      const moved = replaced(list.items.filter(i => i !== item))
      const lists = await store(
        moved.some(l => l.name === into)
          ? moved.map(l => (l.name === into ? { ...l, items: targetItems } : l))
          : [...moved, { name: into, items: targetItems }],
      )
      // `many` holds now: two lists are named in this change.
      return { ok: true, text: `Moved ${into} ${to}. ${item.title}${forModel ? ` (#${item.uid})` : ''} (was ${name} ${at + 1})`, lists }
    }
    case 'remove': {
      if (!item) return missing()
      // Gone from the list: the items after it move up a place, and keep their uids.
      const lists = await store(replaced(list.items.filter(i => i !== item)))
      const moved = forModel && at < list.items.length - 1 ? '; the items after it moved up one place' : ''
      return { ok: true, text: `Removed ${named(item)}${moved}`, lists }
    }
    case 'clear': {
      // The list goes; uids carry on, so an old one never names a new item.
      const lists = await store(data.lists.filter(l => l !== list))
      const removed = list.items.map((i, n) => label(i, n + 1).replace(where(name), ''))
      const from = many() ? ` from ${name}` : ''
      return {
        ok: true,
        lists,
        text: `Cleared ${removed.length} item${removed.length === 1 ? '' : 's'}${from}: ${removed.join('; ')}`,
      }
    }
    case 'use': {
      const lists = await store(data.lists)
      return { ok: true, text: `${name} is the current list.`, lists }
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
function callLine(input: Record<string, unknown>, lists: List[]): string {
  const uid = input.id === undefined ? undefined : uidOf(input.id)
  const known = uid === undefined ? undefined : lists.flatMap(l => l.items).find(i => i.uid === uid)
  const which =
    input.title !== undefined ? ` "${String(input.title)}"`
    : known ? ` "${known.title}"`
    : input.position !== undefined ? ` ${String(input.position)}`
    : ''
  const list = input.list === undefined ? '' : ` ${input.action === 'list' ? '' : 'in '}${String(input.list)}`
  const into = input.into === undefined ? '' : ` to ${String(input.into)}`
  const to = input.to === undefined ? '' : `${into ? '' : ' to'} ${String(input.to)}`
  return `Checklist · ${String(input.action ?? '')}${which}${list}${into}${to}`
}

/**
 * A tool answer in a line, uids left out: its first, or a count when it is lists.
 * Undefined for an answer in no shape this tool gives, which the engine draws.
 */
function resultLine(output: unknown): string | undefined {
  if (typeof output !== 'string' || !output) return undefined
  const lines = output.split('\n')
  const first = lines[0] ?? ''
  const isRow = (l: string) => Object.values(MARK).some(m => l.startsWith(`${m} `))
  const heads = lines.filter(l => l.startsWith('{'))
  if (!isRow(first) && heads.length === 0)
    return first.replace(/ \(#\d+\)/g, '').replace(/; the items after it moved up one place$/, '')
  const rows = lines.filter(isRow)
  const open = rows.filter(l => l.startsWith(`${MARK.open} `)).length
  const count = `${rows.length} item${rows.length === 1 ? '' : 's'}, ${open} open`
  if (heads.length === 1) return `${(heads[0] ?? '').replace(/^\{([^}]*)\}.*$/, '$1')}: ${count}`
  return heads.length > 1 ? `${count}, in ${heads.length} lists` : count
}

/** Lists as Claude reads them: a `{name}` line, then each item's mark, position, title, uid, detail. */
function summary(data: Lists, only?: string): string {
  const shown = only === undefined ? data.lists : data.lists.filter(l => l.name === only)
  if (shown.length === 0) return 'The checklist is empty.'
  return shown
    .map(l =>
      [
        `{${l.name}}${l.name === data.current ? ' (current)' : ''}`,
        ...l.items.map((i, n) => `${MARK[i.status]} ${n + 1}. ${i.title} (#${i.uid})${i.detail ? ` -- ${i.detail}` : ''}`),
      ].join('\n'),
    )
    .join('\n\n')
}

/** A click on a row: open becomes done, done and dropped become open. */
const toggled = (status: Status): Status => (status === 'open' ? 'done' : 'open')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'checklist',
      description: "This session's checklists pane: add, edit, move, done|open|drop, remove, clear, @list, close, version",
    })
    await $.tool.register({
      name: 'checklist',
      isDeferred: false,
      description:
        "This session's checklists, shown in a pane beside the chat; other sessions have their own. " +
        'Use it to record tasks the user agrees on, mark them done as you finish them, or read what is open. ' +
        'A session can hold several named lists (say to-do and chores); one is current, marked in the pane. ' +
        'The user sees items by position within their list (1, 2, 3, with no gaps: a removed item is gone and the ones ' +
        'after it move up). You also see each item\'s id (#12), unique across all lists, never changed or reused. ' +
        'Name an item by id when you are tracking it yourself; by position when you repeat a number the user ' +
        'gave, since a position is read against the list as it stands now, which is what the user sees. ' +
        '`list` names the list an add, a clear or a position is in, and makes it current; without it they mean the ' +
        'current list. If that call is denied asking "Which list", the pane is closed and the user cannot see which ' +
        'list is current: ask the user which list they mean, then name it. Adding or moving to a new list name makes ' +
        'that list; a list left empty is deleted. ' +
        'Actions: list (every list, or the one named in list, which becomes current: use it for "show me my chores"); ' +
        'add (title, optional detail); done, open, drop, remove (id or position); edit (id or position, title); ' +
        'move (id or position; to: the new position, into: another list, or both; into alone puts it last); ' +
        'clear (empties and deletes the list). A change answers with the one item it touched, its list named once ' +
        'there are several; list answers with a {name} line per list, (current) beside one, then its items one per ' +
        'line: [ ] open, [x] done or [-] dropped, then position, title, (#id) and any detail.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'done', 'open', 'drop', 'edit', 'move', 'remove', 'clear'] },
          id: { type: 'string', description: "The item's id, as #12 or 12; give this or position" },
          position: { type: 'integer', minimum: 1, description: "The item's place in its list now, from 1" },
          list: { type: 'string', description: 'The list to act on, as to-do; omit for the current list' },
          to: { type: 'integer', minimum: 1, description: 'The place to move the item to, for move' },
          into: { type: 'string', description: 'The list to move the item to, for move' },
          title: { type: 'string', description: 'The title, for add and edit' },
          detail: { type: 'string', description: 'One line of detail, for add' },
        },
        required: ['action'],
      },
    })
    const now = await $.clock.now()
    // Prune first: a list claimed from its project carries no touch time until it is stamped here.
    await prune($, now)
    const key = await sessionKey($)
    await claimProjectList($, key, now)
    const { current, lists } = await load($, key)
    await update($, live, state => ({ ...state, current, lists }))
    // Open unasked only when there is something to show.
    if (lists.length > 0) void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  // /clear goes on under a new session id with no session.start: carry the lists across to it.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, live, state => ({ ...state, carry: true }))
    return next(e)
  })

  // Each prompt makes sure the live lists are this session's, after a /clear or a switch of session.
  on('prompt.submit', async ($, e, next) => {
    await sessionKey($)
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const action = String(e.action ?? '')
    const title = String(e.title ?? '')
    const detail = e.detail === undefined ? undefined : String(e.detail)
    const key = await sessionKey($)
    const status = VERB[action]

    const given = (v: unknown) => v !== undefined && v !== ''
    const list = given(e.list) ? nameOf(e.list) : undefined
    if (given(e.list) && list === undefined) return { deny: `"${String(e.list)}" is no list name: letters, digits, - and _.` }
    const scope = list === undefined ? {} : { list }

    if (action === 'list') {
      if (list === undefined) return { result: summary(await load($, key)) }
      const out = await apply($, key, { kind: 'use', list }, true)
      if (!out.ok) return { deny: out.text }
      void $.ui.open({ id: PANE, title: TITLE })
      return { result: summary(await load($, key), list) }
    }
    if (action === 'add') return answer(await apply($, key, { kind: 'add', title, detail, ...scope }, true))
    if (action === 'clear') return answer(await apply($, key, { kind: 'clear', ...scope }, true))
    if (!status && action !== 'edit' && action !== 'move' && action !== 'remove') return { deny: `Unknown action "${action}". ${USAGE}` }

    // Every other action names one item, by id or by position.
    const hasId = given(e.id)
    const hasPosition = given(e.position)
    if (hasId === hasPosition) return { deny: 'Name the item by id or by position: one of them.' }
    const uid = hasId ? uidOf(e.id) : undefined
    const position = hasPosition ? positionOf(e.position) : undefined
    if (hasId && uid === undefined) return { deny: `"${String(e.id)}" is no id: an id is a number, as #12.` }
    if (hasPosition && position === undefined) return { deny: `"${String(e.position)}" is no position: 1 or more.` }
    const ref: Ref = uid !== undefined ? { uid } : { position: position! }

    let op: Op
    if (action === 'move') {
      const to = given(e.to) ? positionOf(e.to) : undefined
      const into = given(e.into) ? nameOf(e.into) : undefined
      if (given(e.into) && into === undefined) return { deny: `"${String(e.into)}" is no list name: letters, digits, - and _.` }
      if (given(e.to) && to === undefined) return { deny: `"${String(e.to)}" is no place to move to: a position, 1 or more.` }
      if (to === undefined && into === undefined) return { deny: 'Say where to move it: to (a position), into (a list), or both.' }
      op = { kind: 'move', ref, to, into, ...scope }
    } else {
      op =
        status ? { kind: 'status', ref, status, ...scope }
        : action === 'edit' ? { kind: 'edit', ref, title, ...scope }
        : { kind: 'remove', ref, ...scope }
    }
    return answer(await apply($, key, op, true))

    function answer(out: Outcome) {
      if (out.ask) {
        return {
          deny: `${out.text} The pane is closed, so the user cannot see which list is current: ask them which list they mean, then name it in list.`,
        }
      }
      if (!out.ok) return { deny: out.text }
      if (out.lists.length > 0) void $.ui.open({ id: PANE, title: TITLE })
      return { result: out.text }
    }
  })

  on('command.run', { command: 'checklist' }, async ($, e) => {
    const args = e.args.trim()
    if (!args) {
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: `Checklist pane opened. ${USAGE}` }
    }

    const words = args.split(/\s+/)
    // A leading @name picks the list the rest acts on, and makes it current.
    const lead = words[0] ?? ''
    const list = lead.startsWith('@') ? nameOf(lead) : undefined
    if (lead.startsWith('@') && list === undefined) return { text: USAGE }
    const scope = list === undefined ? {} : { list }
    const [verb, ...rest] = list === undefined ? words : words.slice(1)

    if (verb === undefined) {
      // `/checklist @chores`: show that list.
      const out = await apply($, await sessionKey($), { kind: 'use', list: list! })
      if (out.ok) await $.ui.open({ id: PANE, title: TITLE })
      return { text: out.text }
    }
    if (list === undefined && verb === 'close' && rest.length === 0) {
      await $.ui.close({ id: PANE })
      return { text: 'Checklist pane closed. /checklist reopens it.' }
    }
    if (list === undefined && verb === 'version' && rest.length === 0) {
      const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
      return { text: `${$.plugin.name} ${manifest.version ?? '(no version in plugin.json)'}` }
    }

    // The person names an item by its position, as the pane shows it.
    const status = VERB[verb]
    const position = rest[0] === undefined ? undefined : positionOf(rest[0])
    const ref: Ref | undefined = position === undefined ? undefined : { position }
    let op: Op | undefined
    if (verb === 'add') {
      const body = rest.join(' ')
      const [rawTitle, ...detailParts] = body.split(/\s+--\s+|^--\s+|\s+--$/)
      const title = (rawTitle ?? '').trim()
      if (title) op = { kind: 'add', title, detail: detailParts.join(' -- '), ...scope }
    } else if (status && ref && rest.length === 1) {
      op = { kind: 'status', ref, status, ...scope }
    } else if (verb === 'edit' && ref && rest.length >= 2) {
      op = { kind: 'edit', ref, title: rest.slice(1).join(' '), ...scope }
    } else if (verb === 'move' && ref) {
      // `move 4 to 2`, `move 4 2`, `move 4 to @chores`, `move 4 to @chores 1`, `move 4 @chores 1`.
      const tail = rest.slice(1)
      if (tail[0] === 'to') tail.shift()
      const into = tail[0]?.startsWith('@') ? nameOf(tail.shift()) : undefined
      const to = tail.length === 1 ? positionOf(tail[0]) : undefined
      const valid = tail.length === 0 ? into !== undefined : tail.length === 1 && to !== undefined
      if (valid) op = { kind: 'move', ref, to, into, ...scope }
    } else if (verb === 'remove' && ref && rest.length === 1) {
      op = { kind: 'remove', ref, ...scope }
    } else if (verb === 'clear' && rest.length === 0) {
      op = { kind: 'clear', ...scope }
    }
    if (!op) return { text: USAGE }

    const out = await apply($, await sessionKey($), op)
    if (out.ask) return { text: `${out.text} Name it first, as /checklist @${out.lists[0]?.name ?? FIRST} ${args}` }
    if (!out.ok) return { text: USAGE }
    if (op.kind !== 'clear') await $.ui.open({ id: PANE, title: TITLE })
    return { text: out.text }
  })

  // Claude's calls to the tool, one line each in the transcript; ctrl+o shows them whole.
  on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e, next) => {
    if (e.props.isExpanded || typeof e.props.input !== 'object' || e.props.input === null) return next(e)
    const { Text } = $.ui.resolve(e)
    const { lists } = await read($, live)
    return <Text dimColor={e.props.isRunning}>{callLine(e.props.input as Record<string, unknown>, lists)}</Text>
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
    const { key, current, lists } = await read($, live)
    const wide = e.props.bodyColumns >= 56

    if (lists.length === 0) {
      return (
        <Box flexDirection="column">
          <Text bold>0 open of 0</Text>
          <Text dimColor>Nothing yet. /checklist add &lt;title&gt; [-- detail]</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {lists.map((list, n) => {
          const isCurrent = list.name === current
          const open = list.items.filter(i => i.status === 'open').length
          return (
            <Box key={list.name} flexDirection="column" marginTop={n > 0 ? 1 : 0}>
              {/* The current list's heading is bold with a ▸; a click on another makes it current. */}
              <Button key={`list:${list.name}`} plain onPress={() => void apply($, key, { kind: 'use', list: list.name })}>
                <Text bold={isCurrent} dimColor={!isCurrent}>
                  {isCurrent ? '▸' : ' '} {list.name} · {open} open of {list.items.length}
                </Text>
              </Button>
              {list.items.map((item, at) => {
                const isOpen = item.status === 'open'
                return (
                  <Box key={String(item.uid)} flexDirection="column" paddingLeft={2}>
                    <Button
                      key={`item:${item.uid}`}
                      plain
                      dimColor={!isOpen}
                      // By uid: a click toggles the row it was drawn for, whatever has moved since.
                      onPress={() =>
                        void apply($, key, { kind: 'status', ref: { uid: item.uid }, status: toggled(item.status) })
                      }
                    >
                      {MARK[item.status]}{' '}
                      <Text bold={isOpen} dimColor={!isOpen} strikethrough={item.status === 'dropped'}>
                        {at + 1}. {item.title}
                      </Text>
                    </Button>
                    {wide && item.detail && <Text dimColor>      {item.detail}</Text>}
                  </Box>
                )
              })}
            </Box>
          )
        })}
      </Box>
    )
  })
}
