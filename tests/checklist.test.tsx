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

/** The engine beneath the plugin: a store, a project, and the pane's answers. */
function stubEngine(on: On, initial = '/work/alpha', saved?: Record<string, unknown>) {
  let project = initial
  mock.store(on, saved)
  on('command.register', () => ({ value: { command: 'checklist' } }))
  on('session.repo', () => ({ value: { root: project, remote: null, internal: false, name: null } }))
  on('session.root', () => ({ value: project }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  return { opened, setProject: (root: string) => void (project = root) }
}

const run = ($: any, args: string) => $.command.run({ command: 'checklist', args })

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
    expect((await ui.find({ type: 'Text', text: /Write the README/ }))?.text).toBe('[ ] 1. Write the README')
    expect((await ui.find({ type: 'Text', text: /Ship it/ }))?.text).toBe('[x] 2. Ship it')
    expect((await ui.find({ type: 'Text', text: /Weigh the cost/ }))?.text).toBe('[-] 3. Weigh the cost')
    expect((await ui.find({ type: 'Text', text: /usage and install/ }))?.text).toContain('usage and install lines')
    await ui.unmount()
  }

  // Narrower than 56 columns, the detail line is left out.
  const narrow = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 }, surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: /usage and install/ })).toBeUndefined()
  expect((await narrow.find({ type: 'Text', text: /Write the README/ }))?.text).toBe('[ ] 1. Write the README')
  await narrow.unmount()
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

  // The removed id is not reused.
  expect((await run($, 'add Third thing')).text).toBe('Added 3. Third thing')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('1 open of 2')
  expect((await ui.find({ type: 'Text', text: /renamed/ }))?.text).toBe('[-] 2. Second thing, renamed')
  await ui.unmount()

  expect((await run($, 'clear')).text).toBe('Cleared 2 items: 2. Second thing, renamed; 3. Third thing')
  expect((await run($, 'clear')).text).toBe('The checklist was already empty.')
})

test('unknown input prints one line of usage', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)
  await run($, 'add Only item')

  for (const bad of ['frobnicate', 'done', 'done 9', 'done 1 2', 'edit 1', 'remove', 'add', 'clear now']) {
    const ran = await run($, bad)
    expect(ran.text).toContain('/checklist [add <title>')
    expect(ran.text.split('\n').length).toBe(1)
  }
})

test('each project keeps its own list', async ($, on) => {
  const { setProject } = stubEngine(on, '/work/alpha')
  await $.session.start(START)
  await run($, 'add Alpha only')

  // A session in another repository: the engine answers a different root.
  setProject('/work/beta')
  await $.session.start({ ...START, cwd: '/work/beta' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('0 open of 0')
  expect(await ui.find({ type: 'Text', text: /Alpha only/ })).toBeUndefined()
  await ui.unmount()

  expect((await run($, 'add Beta only')).text).toBe('Added 1. Beta only')
  expect((await run($, 'done 1')).text).toBe('1. Beta only is now done.')
  // Back in the first project, its list is untouched and beta's is unseen.
  setProject('/work/alpha')
  await $.session.start(START)
  const alpha = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await alpha.find({ type: 'Text', text: /open of/ }))?.text).toBe('1 open of 1')
  expect((await alpha.find({ type: 'Text', text: /Alpha only/ }))?.text).toBe('[ ] 1. Alpha only')
  expect(await alpha.find({ type: 'Text', text: /Beta only/ })).toBeUndefined()
  await alpha.unmount()
  expect((await run($, 'add Alpha again')).text).toBe('Added 2. Alpha again')
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

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('1 open of 2')
  expect((await ui.find({ type: 'Text', text: /Kept done/ }))?.text).toBe('[x] 3. Kept done')
  expect((await ui.find({ type: 'Text', text: /from last time/ }))?.text).toContain('from last time')
  await ui.unmount()

  // The next id carries on from where the earlier session left it.
  expect((await run($, 'add New this session')).text).toBe('Added 4. New this session')
})
