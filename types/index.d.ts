export type Status = 'open' | 'done' | 'dropped'

export type Item = {
  /** The item's own id: kept for its life and never handed out again. Claude names items by it. */
  uid: number
  title: string
  detail?: string
  status: Status
}

/** One named list. In list order: an item's position is its place here, from 1, with no gaps. */
export type List = {
  name: string
  items: Item[]
}

/** A session's lists, as the store keeps them under `session:<id>`. */
export type Lists = {
  /** The next uid to hand out: uids are unique across all of the session's lists. */
  next: number
  /** The list a bare position names; '' when there are no lists. */
  current: string
  /** Each list holds at least one item: an emptied list is let go. */
  lists: List[]
}

declare module 'claude-code' {
  // Shaped is the engine's own type, in scope inside this module.
  interface PluginState {
    checklist: {
      /** The store key of the session's lists, whether a /clear is carrying them over, and the lists themselves. */
      list: Shaped<{ key: string; carry: boolean; current: string; lists: List[] }>
    }
  }
}
