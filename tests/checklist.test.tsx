import { expect, mock, test } from 'claude-code/testing'

type On = Parameters<Parameters<typeof test>[1]>[1]

const PANE = {
  plugin: 'checklist',
  component: 'Pane',
  requestId: 'checklist',
  props: {
    title: 'Checklist',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const START = { cwd: '/work/alpha', surface: 'terminal', isInteractive: true } as const
const TOOL = 'mcp__checklist__checklist'

/** The engine beneath the plugin: a store, a project, and the pane's answers. */
function stubEngine(on: On, initial = '/work/alpha', saved?: Record<string, unknown>) {
  // The session's root, and the repository its shell is in now: a shell `cd` moves only the second.
  let project = initial
  let repo: string | null = initial
  let session = 'session-one'
  let now = Date.UTC(2026, 9, 23)
  mock.store(on, saved)
  on('command.register', () => ({ value: { command: 'checklist' } }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('tool.call', () => ({ deny: 'nothing beneath the plugin serves this tool' }))
  on('session.repo', () => ({ value: repo === null ? null : { root: repo, remote: null, internal: false, name: null } }))
  on('session.root', () => ({ value: project }))
  on('session.id', () => ({ value: session }))
  on('clock.now', () => ({ value: now }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: [] }))
  // The engine's own drawing of a site, where a hook hands it on.
  on('ui.render', () => ({ type: 'Text', children: ['engine'] }))
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  const closed: string[] = []
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  return {
    opened,
    closed,
    setProject: (root: string) => void (project = repo = root),
    setShellDir: (repoRoot: string | null) => void (repo = repoRoot),
    setSession: (id: string) => void (session = id),
    passDays: (days: number) => void (now += days * 24 * 60 * 60 * 1000),
  }
}

const run = ($: any, args: string) => $.command.run({ command: 'checklist', args })
const row = (ui: any, id: string) => ui.find({ type: 'Button', key: `item:${id}` })

test('the pane shows the header, marks, and details when wide', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)
  await run($, 'add Write the README -- usage and install lines')
  await run($, 'add Ship it')
  await run($, 'add Weigh the cost')
  await run($, 'done 2')
  await run($, 'drop 3')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('1 open of 3')
    expect((await row(ui, '1'))?.text).toBe('[ ] 1. Write the README')
    expect((await row(ui, '2'))?.text).toBe('[x] 2. Ship it')
    expect((await row(ui, '3'))?.text).toBe('[-] 3. Weigh the cost')
    expect((await ui.find({ type: 'Text', text: /usage and install/ }))?.text).toContain('usage and install lines')
    await ui.unmount()
  }

  // Narrower than 56 columns, the detail line is left out.
  const narrow = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 }, surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: /usage and install/ })).toBeUndefined()
  expect((await row(narrow, '1'))?.text).toBe('[ ] 1. Write the README')
  await narrow.unmount()
})

test('a click on a row toggles it between open and done', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)
  await run($, 'add Click me')
  await run($, 'add Dropped one')
  await run($, 'drop 2')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'item:1' })
  expect((await row(ui, '1'))?.text).toBe('[x] 1. Click me')
  await ui.press({ key: 'item:1' })
  expect((await row(ui, '1'))?.text).toBe('[ ] 1. Click me')
  // A dropped item comes back to open.
  await ui.press({ key: 'item:2' })
  expect((await row(ui, '2'))?.text).toBe('[ ] 2. Dropped one')
  expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('2 open of 2')
  await ui.unmount()

  // The click reached the store: a new session reads it back.
  await $.session.start(START)
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await again.find({ type: 'Text', text: /open of/ }))?.text).toBe('2 open of 2')
  await again.unmount()

  // After the first is removed, a click still toggles the row it was drawn for, now first.
  await run($, 'remove 1')
  const moved = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await moved.press({ key: 'item:2' })
  expect((await row(moved, '2'))?.text).toBe('[x] 1. Dropped one')
  await moved.unmount()
})

test('an empty project shows an empty pane and does not open it at start', async ($, on) => {
  const { opened } = stubEngine(on)
  await $.session.start(START)
  expect(opened).toEqual([])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('0 open of 0')
  await ui.unmount()

  const ran = await run($, '')
  expect(ran.text).toContain('Checklist pane opened')
  expect(opened).toEqual(['checklist'])
})

test('/checklist close closes the pane', async ($, on) => {
  const { closed } = stubEngine(on)
  await $.session.start(START)
  await run($, '')

  const ran = await run($, 'close')
  expect(ran.text).toBe('Checklist pane closed. /checklist reopens it.')
  expect(closed).toEqual(['checklist'])
  expect((await run($, 'close now')).text).toContain('/checklist [add <title>')
})

test('each command changes the list and reports what it did', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)

  expect((await run($, 'add First thing')).text).toBe('Added 1. First thing')
  expect((await run($, 'add Second thing -- with a detail')).text).toBe('Added 2. Second thing')
  expect((await run($, 'done 1')).text).toBe('1. First thing is now done.')
  expect((await run($, 'open 1')).text).toBe('1. First thing is now open.')
  expect((await run($, 'drop 2')).text).toBe('2. Second thing is now dropped.')
  expect((await run($, 'edit 2 Second thing, renamed')).text).toBe('2. Second thing, renamed (was: Second thing)')
  expect((await run($, 'remove 1')).text).toBe('Removed 1. First thing')

  // A removed item is gone and the rest move up: the numbers never skip.
  expect((await run($, 'add Third thing')).text).toBe('Added 2. Third thing')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('1 open of 2')
  expect(await ui.find({ type: 'Text', text: /First thing/ })).toBeUndefined()
  // Rows are keyed by uid; their numbers are positions.
  expect((await row(ui, '2'))?.text).toBe('[-] 1. Second thing, renamed')
  expect((await row(ui, '3'))?.text).toBe('[ ] 2. Third thing')
  await ui.unmount()
  // Claude reads the uids beside the positions.
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe(
    '[-] 1. Second thing, renamed (#2) -- with a detail\n[ ] 2. Third thing (#3)',
  )

  expect((await run($, 'clear')).text).toBe('Cleared 2 items: 1. Second thing, renamed; 2. Third thing')
  expect((await run($, 'clear')).text).toBe('The checklist was already empty.')
})

test('unknown input prints one line of usage', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)
  await run($, 'add Only item')

  for (const bad of ['frobnicate', 'done', 'done 9', 'done 0', 'done x', 'done #1', 'done 1 2', 'edit 1', 'remove', 'add', 'clear now']) {
    const ran = await run($, bad)
    expect(ran.text).toContain('/checklist [add <title>')
    expect(ran.text.split('\n').length).toBe(1)
  }
})

test('the model manages the list through the checklist tool', async ($, on) => {
  const { opened } = stubEngine(on)
  await $.session.start(START)

  const added = await $.tool.call({ tool: TOOL, action: 'add', title: 'From the model', detail: 'agreed in chat' })
  // A change answers with the one item it touched, its uid beside its position.
  expect(added.result).toBe('Added 1. From the model (#1)')
  expect(opened).toEqual(['checklist'])

  expect((await $.tool.call({ tool: TOOL, action: 'done', id: '#1' })).result).toBe('1. From the model (#1) is now done.')
  expect((await $.tool.call({ tool: TOOL, action: 'edit', id: '1', title: 'Renamed' })).result).toBe(
    '1. Renamed (#1) (was: From the model)',
  )
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe('[x] 1. Renamed (#1) -- agreed in chat')

  // What the person typed and what the model did share one list.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await row(ui, '1'))?.text).toBe('[x] 1. Renamed')
  await ui.unmount()
  expect((await run($, 'remove 1')).text).toBe('Removed 1. Renamed')
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe('The checklist is empty.')

  // A bad call is refused with the reason.
  expect((await $.tool.call({ tool: TOOL, action: 'done', id: '1' })).deny).toBe('No item #1.')
  expect((await $.tool.call({ tool: TOOL, action: 'done', position: 9 })).deny).toBe('No item at position 9.')
  expect((await $.tool.call({ tool: TOOL, action: 'done' })).deny).toBe('Name the item by id or by position: one of them.')
  expect((await $.tool.call({ tool: TOOL, action: 'done', id: '1', position: 1 })).deny).toBe(
    'Name the item by id or by position: one of them.',
  )
  expect((await $.tool.call({ tool: TOOL, action: 'done', id: 'abc' })).deny).toContain('is no id')
  expect((await $.tool.call({ tool: TOOL, action: 'done', position: 0 })).deny).toContain('is no position')
  expect((await $.tool.call({ tool: TOOL, action: 'frobnicate' })).deny).toContain('Unknown action')
})

test('an id names the same item however the positions move; a position names the list as it is now', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)
  for (const title of ['Alpha', 'Beta', 'Gamma', 'Delta']) await $.tool.call({ tool: TOOL, action: 'add', title })

  // Claude removes one: it is told the rest moved up.
  expect((await $.tool.call({ tool: TOOL, action: 'remove', position: 2 })).result).toBe(
    'Removed 2. Beta (#2); the items after it moved up one place',
  )
  // The person removes the first in the pane's numbering, unseen by Claude.
  expect((await run($, 'remove 1')).text).toBe('Removed 1. Alpha')

  // Claude's #3 is still Gamma, though Gamma is now first.
  expect((await $.tool.call({ tool: TOOL, action: 'done', id: '#3' })).result).toBe('1. Gamma (#3) is now done.')
  // "Mark 2 done", as the person sees 2 now: Delta.
  expect((await $.tool.call({ tool: TOOL, action: 'done', position: 2 })).result).toBe('2. Delta (#4) is now done.')

  // A uid is never handed out again, after a remove or a clear.
  expect((await $.tool.call({ tool: TOOL, action: 'add', title: 'Epsilon' })).result).toBe('Added 3. Epsilon (#5)')
  expect((await $.tool.call({ tool: TOOL, action: 'remove', id: '5' })).result).toBe('Removed 3. Epsilon (#5)')
  await $.tool.call({ tool: TOOL, action: 'clear' })
  expect((await $.tool.call({ tool: TOOL, action: 'add', title: 'Zeta' })).result).toBe('Added 1. Zeta (#6)')
  expect((await $.tool.call({ tool: TOOL, action: 'done', id: '#3' })).deny).toBe('No item #3.')
})

test('each session keeps its own list, even in the same project', async ($, on) => {
  const { setSession } = stubEngine(on, '/work/alpha')
  await $.session.start(START)
  await run($, 'add One only')

  // Another session in the same directory starts with a list of its own.
  setSession('session-two')
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('0 open of 0')
  await ui.unmount()
  expect((await run($, 'add Two only')).text).toBe('Added 1. Two only')
  expect((await run($, 'done 1')).text).toBe('1. Two only is now done.')

  // Resuming the first session brings back its list, untouched by the second.
  setSession('session-one')
  await $.session.start(START)
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe('[ ] 1. One only (#1)')
})

test('a list saved by an earlier session is read back and opens the pane', async ($, on) => {
  const saved = {
    'project:/work/alpha': {
      next: 4,
      items: [
        { id: '1', title: 'Kept open', status: 'open', detail: 'from last time' },
        { id: '3', title: 'Kept done', status: 'done' },
      ],
    },
  }
  const { opened } = stubEngine(on, '/work/alpha', saved)
  await $.session.start(START)
  expect(opened).toEqual(['checklist'])

  // Saved before uids: each item's number becomes its uid, and the gap closes.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('1 open of 2')
  expect((await row(ui, '3'))?.text).toBe('[x] 2. Kept done')
  expect((await ui.find({ type: 'Text', text: /from last time/ }))?.text).toContain('from last time')
  await ui.unmount()

  // The new item goes last, and its uid carries on from the saved one.
  expect((await run($, 'add New this session')).text).toBe('Added 3. New this session')
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe(
    '[ ] 1. Kept open (#1) -- from last time\n[x] 2. Kept done (#3)\n[ ] 3. New this session (#4)',
  )
})

test('a shell cd during the session keeps the list where it was', async ($, on) => {
  const { setShellDir } = stubEngine(on, '/work/alpha')
  await $.session.start(START)
  await run($, 'add Before the cd')

  // The shell leaves the repository: git answers nothing, but the session's root has not moved.
  setShellDir(null)
  expect((await run($, 'add After leaving')).text).toBe('Added 2. After leaving')
  // Into another repository: still the same list.
  setShellDir('/work/beta')
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe(
    '[ ] 1. Before the cd (#1)\n[ ] 2. After leaving (#2)',
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('2 open of 2')
  await ui.press({ key: 'item:1' })
  expect((await row(ui, '1'))?.text).toBe('[x] 1. Before the cd')
  await ui.unmount()

  // A reload runs session.start again from the moved shell: the list stays put.
  await $.session.start(START)
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe(
    '[x] 1. Before the cd (#1)\n[ ] 2. After leaving (#2)',
  )
})

test('a /cd keeps the session\'s list', async ($, on) => {
  const { setProject } = stubEngine(on, '/work/alpha')
  await $.session.start(START)
  await run($, 'add Alpha thing')

  setProject('/work/beta')
  expect((await run($, 'add Beta thing')).text).toBe('Added 2. Beta thing')
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe(
    '[ ] 1. Alpha thing (#1)\n[ ] 2. Beta thing (#2)',
  )
})

test('/clear carries the list over to the session it starts', async ($, on) => {
  const { setSession } = stubEngine(on)
  await $.session.start(START)
  await run($, 'add Survives the clear')

  // /clear ends the session and goes on under a new id, with no session.start.
  await $.session.end({ reason: 'clear', sessionId: 'session-one', resume: { id: 'session-one' } })
  setSession('session-cleared')
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe('[ ] 1. Survives the clear (#1)')
  expect((await run($, 'add After the clear')).text).toBe('Added 2. After the clear')

  // The list moved: the old id no longer holds it.
  setSession('session-one')
  await $.session.start(START)
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe('The checklist is empty.')
})

test('a switch to another session brings that session\'s list at the next prompt', async ($, on) => {
  const { setSession } = stubEngine(on)
  setSession('session-two')
  await $.session.start(START)
  await run($, 'add Two\'s item')
  setSession('session-one')
  await $.session.start(START)
  await run($, 'add One\'s item')

  // An in-terminal resume of session two: it ends one, and no session.start follows.
  await $.session.end({ reason: 'resume', sessionId: 'session-one', resume: { id: 'session-one' } })
  setSession('session-two')
  await $.prompt.submit({ text: 'carry on' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Two's item/ }))?.text).toContain("1. Two's item")
  expect(await ui.find({ type: 'Text', text: /One's item/ })).toBeUndefined()
  await ui.unmount()
})

test('a project\'s old list goes to the first session there, once', async ($, on) => {
  const saved = { 'project:/work/alpha': { next: 2, items: [{ id: '1', title: 'From before', status: 'open' }] } }
  const { setSession } = stubEngine(on, '/work/alpha', saved)
  await $.session.start(START)
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe('[ ] 1. From before (#1)')

  setSession('session-two')
  await $.session.start(START)
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe('The checklist is empty.')
})

test('a list no session has touched for 90 days is let go', async ($, on) => {
  const { setSession, passDays } = stubEngine(on)
  await $.session.start(START)
  await run($, 'add Old one')
  setSession('session-two')
  await $.session.start(START)
  await run($, 'add Recent one')

  passDays(60)
  setSession('session-three')
  await $.session.start(START)
  await run($, 'add Newest one')
  // Session two is touched again on day 60; session one is not.
  setSession('session-two')
  await $.session.start(START)
  await run($, 'done 1')

  passDays(31)
  setSession('session-four')
  await $.session.start(START)
  for (const [id, list] of [
    ['session-one', 'The checklist is empty.'],
    ['session-two', '[x] 1. Recent one (#1)'],
    ['session-three', '[ ] 1. Newest one (#1)'],
  ]) {
    setSession(id)
    await $.session.start(START)
    expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe(list)
  }
})

test('/checklist version prints the version in the plugin\'s own manifest', async ($, on) => {
  stubEngine(on)
  const read: string[] = []
  on('fs.read', (_, e) => {
    read.push(e.path)
    return { value: JSON.stringify({ name: 'checklist', version: '9.8.7' }) }
  })
  await $.session.start(START)

  expect((await run($, 'version')).text).toBe('checklist 9.8.7')
  expect(read).toHaveLength(1)
  expect(read[0]).toEndWith('/.claude-plugin/plugin.json')
  expect((await run($, 'version now')).text).toContain('/checklist [add <title>')
})

const toolRow = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  plugin: 'checklist',
  component: 'ToolUse',
  requestId: 'toolu_1',
  props: { tool_use_id: 'toolu_1', tool: TOOL, input, isRunning: false, isErrored: false, isInterrupted: false, ...extra },
  surface: 'terminal',
} as const)
const resultBlock = (output: unknown, extra: Record<string, unknown> = {}) => ({
  plugin: 'checklist',
  component: 'ToolResult',
  requestId: 'toolu_1',
  props: { tool_use_id: 'toolu_1', tool: TOOL, output, isErrored: false, ...extra },
  surface: 'terminal',
} as const)
const textOf = async (ui: any) => (await ui.find({ type: 'Text', text: /\S/ }))?.text

test('a checklist tool call is drawn as one short line', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)

  await run($, 'add Ship it')

  // Never a uid: an item named by id shows its title, or its id once it is gone.
  for (const [input, line] of [
    [{ action: 'add', title: 'Write the README', detail: 'a long detail the row leaves out' }, 'Checklist · add "Write the README"'],
    [{ action: 'done', position: 3 }, 'Checklist · done 3'],
    [{ action: 'done', id: '#1' }, 'Checklist · done "Ship it"'],
    [{ action: 'done', id: '#7' }, 'Checklist · done'],
    [{ action: 'edit', id: '1', title: 'Renamed' }, 'Checklist · edit "Renamed"'],
    [{ action: 'list' }, 'Checklist · list'],
  ] as const) {
    const ui = await $.ui.mount(toolRow(input))
    expect(await textOf(ui)).toBe(line)
    await ui.unmount()
  }
})

test('a checklist tool result shows its first line, or a count for a list', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)

  // The uid Claude reads is left out of what the person sees.
  const added = await $.ui.mount(resultBlock('Added 3. Write the README (#12)'))
  expect(await textOf(added)).toBe('Added 3. Write the README')
  await added.unmount()

  const removed = await $.ui.mount(resultBlock('Removed 2. Beta (#2); the items after it moved up one place'))
  expect(await textOf(removed)).toBe('Removed 2. Beta')
  await removed.unmount()

  const listed = await $.ui.mount(resultBlock('[ ] 1. One (#1) -- a detail\n[x] 2. Two (#4)\n[-] 3. Three (#5)'))
  expect(await textOf(listed)).toBe('3 items, 1 open')
  await listed.unmount()

  const empty = await $.ui.mount(resultBlock('The checklist is empty.'))
  expect(await textOf(empty)).toBe('The checklist is empty.')
  await empty.unmount()
})

test('the expanded view and errors keep the engine\'s full drawing', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)

  const row = await $.ui.mount(toolRow({ action: 'done', position: 3 }, { isExpanded: true }))
  expect(await row.find({ type: 'Text', text: 'Checklist · done 3' })).toBeUndefined()
  await row.unmount()

  const full = '1. One is now done.\n[x] 1. One'
  const expanded = await $.ui.mount(resultBlock(full, { isExpanded: true }))
  expect(await expanded.find({ type: 'Text', text: '1. One is now done.' })).toBeUndefined()
  await expanded.unmount()

  const errored = await $.ui.mount(resultBlock('No item 9.', { isErrored: true }))
  expect(await errored.find({ type: 'Text', text: 'No item 9.' })).toBeUndefined()
  await errored.unmount()
})

test('a list saved with removed items lets them go and closes the gaps', async ($, on) => {
  const saved = {
    'project:/work/alpha': {
      items: [
        { id: '1', title: 'Kept', status: 'done' },
        { id: '2', title: 'Typo item', status: 'removed' },
        { id: '4', title: 'Real item', status: 'open' },
      ],
    },
  }
  stubEngine(on, '/work/alpha', saved)
  await $.session.start(START)

  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe('[x] 1. Kept (#1)\n[ ] 2. Real item (#4)')
  expect((await run($, 'add Next')).text).toBe('Added 3. Next')
  expect((await $.tool.call({ tool: TOOL, action: 'done', id: '#5' })).result).toBe('3. Next (#5) is now done.')
})

test('move puts an item at a new position and shifts the ones between', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)
  for (const title of ['One', 'Two', 'Three', 'Four']) await run($, `add ${title}`)
  const titles = async () =>
    ((await $.tool.call({ tool: TOOL, action: 'list' })).result as string).split('\n').map(l => l.replace(/^\[.\] \d+\. | \(#\d+\)$/g, ''))

  expect((await run($, 'move 4 to 2')).text).toBe('Moved 2. Four (was 4)')
  expect(await titles()).toEqual(['One', 'Four', 'Two', 'Three'])
  expect((await run($, 'move 1 3')).text).toBe('Moved 3. One (was 1)')
  expect(await titles()).toEqual(['Four', 'Two', 'One', 'Three'])
  expect((await run($, 'move 2 to 2')).text).toBe('2. Two is already there.')

  // Claude names the item by id; its uid stays with it.
  expect((await $.tool.call({ tool: TOOL, action: 'move', id: '#1', to: 4 })).result).toBe('Moved 4. One (#1) (was 3)')
  expect(await titles()).toEqual(['Four', 'Two', 'Three', 'One'])

  for (const bad of ['move', 'move 1', 'move 1 to', 'move 1 to 9', 'move 9 to 1', 'move 1 to 0', 'move 1 into 2', 'move 1 to 2 3'])
    expect((await run($, bad)).text).toContain('/checklist [add <title>')
  expect(await titles()).toEqual(['Four', 'Two', 'Three', 'One'])
  expect((await $.tool.call({ tool: TOOL, action: 'move', position: 1 })).deny).toContain('no place to move to')
  expect((await $.tool.call({ tool: TOOL, action: 'move', position: 1, to: 9 })).deny).toBe('No position 9: the list has 4.')
})
