export type Status = 'open' | 'done' | 'dropped'

export type Item = {
  id: string
  title: string
  detail?: string
  status: Status
}

/** One project's punchlist, as the store keeps it under `project:<root>`. */
export type Project = {
  /** The next id to hand out. */
  next: number
  items: Item[]
}

declare module 'claude-code' {
  interface PluginState {
    punchlist: {
      /** The project the session is in, and its live list. */
      list: { project: string; items: Item[] }
    }
  }
}
