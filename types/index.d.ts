export type Status = 'open' | 'done' | 'dropped' | 'removed'

export type Item = {
  id: string
  title: string
  detail?: string
  status: Status
}

/** One project's checklist, as the store keeps it under `project:<root>`. */
export type Project = {
  /** In id order; a new item takes the lowest id none holds. */
  items: Item[]
}

declare module 'claude-code' {
  interface PluginState {
    checklist: {
      /** The project the session is in, the session root it was worked out from, and its live list. */
      list: { project: string; root: string; items: Item[] }
    }
  }
}
