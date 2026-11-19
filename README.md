# checklist

A Claude Code pane beside the chat that holds the checklists for the
session you are in: one or more named lists (say `to-do` and `chores`),
where each item has a number, a title, an optional one-line detail, and a
status of open, done, or dropped. Every session keeps its own lists in
the plugin's store, so two sessions in the same directory never see or
change each other's items. The list stays with its session: through a `cd`
or a `/cd`, a plugin reload, and a `/clear`, which carries it over to the
fresh conversation, and `claude --resume` brings it back. A list no session
has touched for 90 days is deleted. The pane opens by itself at session
start only when the session already has items.

Lists from before 0.7.0 were kept per project: the first session to start
in a project takes that project's list as its own, and later ones start
empty.

## Requirements

Claude Code **2.1.287 or later**: this is a mod (a plugin with a hooks
module), and earlier builds have no pane, no command hook and no plugin
tools, so the plugin does not load there at all. The shell install form
below needs 2.1.292 or later. A session that reaches Claude through
Bedrock, Vertex or Foundry needs 2.1.304. Written against 2.1.306 and
tested on 2.1.296 and 2.1.306.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install checklist --marketplace mjb-it/checklist
```

Answer `y` to add the marketplace, then pick a scope (user is the usual one).

From a shell:

```
claude plugin install checklist --marketplace mjb-it/checklist
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `mjb-it/checklist`, then Add plugin.

## Usage

At the prompt:

```
/checklist                              open the pane
/checklist @<list>                      make that list current
/checklist add <title> [-- detail]      add an item at the end
/checklist done <n>                     mark item n done      [x]
/checklist open <n>                     mark item n open      [ ]
/checklist drop <n>                     mark item n dropped   [-]
/checklist edit <n> <title>             retitle item n
/checklist move <n> to <m>              move item n to position m; the ones between shift
/checklist move <n> to @<list> [<m>]    move item n to another list, last or at position m
/checklist remove <n>                   delete item n; the ones after it move up
/checklist clear                        delete the list; reports what it removed
/checklist close                        close the pane
/checklist version                      print the installed plugin's version
```

Anything else prints one line of usage.

### Named lists

A session can hold several lists, each with a name of letters, digits, `-`
and `_` (`Chores` and `chores` are the same list). One of them is the
**current** list: a bare number, an `add` or a `clear` acts on it. Put
`@<list>` first to act on another list instead, which also makes it
current: `/checklist @chores done 2`, `/checklist @to-do add Call the vet`.

A list is made the first time something is added or moved to its name, and
deleted once it is empty, so there are no blank headings. A session with no
lists yet adds to one called `main`. Lists saved before 0.9.0 come back as
`main`.

When there are several lists and the pane is closed, you cannot see which
list is current, so a bare number is not acted on: the command (or Claude)
asks which list you mean first.

An item's number is its place in its list, so the numbers always run 1, 2,
3 with no gaps: removing or moving one out moves the items after it up a
place.

The pane shows each list under a heading like `▸ chores · 3 open of 10`:
the current list's heading is bold with a `▸`, the others are dim. Under
each heading come its items in order: open items bold, done items dim,
dropped items struck through. The detail shows on a dim second line when
the pane is at least 56 columns wide.

A click on a heading makes that list current. A click on a row toggles it:
an open item becomes done, a done or dropped item becomes open. Clicks
reach the pane in the fullscreen terminal and in the desktop app.

## The Claude session can use it too

The plugin registers a `checklist` tool the model can call, so you can say
"add that to the checklist" or "mark 3 done" in the chat, and Claude can
tick items off as it finishes them. It writes the same session lists the
command and the pane use, so "show me my chores list" or "move 2 to my
to-do list" work in the chat.

Besides its number, each item has an id that only Claude sees (`#12`): it
is unique across all the session's lists, never changes and is never given
to another item, so Claude's hold on an
item survives the numbers moving. Claude names an item by id when it is
tracking it, and by position when it repeats a number you gave; a position
is read against the list as it is at that moment, which is the list you
see. The tool takes an `action` (`list`, `add`, `done`, `open`, `drop`,
`edit`, `move`, `remove`, `clear`) with `id` or `position`, `list`, `to`,
`into`, `title` and `detail` as the action needs. `list` names the list to
act on and makes it current; `into` is the list a `move` sends the item to.
A change answers with the one item it touched (`3. Ship it (#12) is now
done.`, or `chores 3. Ship it (#12) is now done.` once there are several
lists); `list` answers with every list, or just the one named, each under a
`{name}` line.

In the transcript each of those calls is one line, like `Checklist · done 3`,
with one line of result (`3. Ship it is now done.`, or `4 items, 2 open` for
a list), and never an id. ctrl+o shows the calls in full.

## How it hooks Claude Code

The plugin is a mod: one hooks module, `hooks/register.tsx`, and nothing
else runs. What it hooks, and what each hook touches:

- **`session.start`** registers the `/checklist` command and the `checklist`
  tool, reads this session's lists from the plugin's own store, and opens the
  pane when there is at least one. It also deletes lists untouched for 90
  days. It then passes the event on unchanged.
- **`session.end`**: on a `/clear`, marks the list to move to the session id
  the conversation goes on under. It changes nothing else, and passes the
  event on unchanged.
- **`prompt.submit`**: checks that the live list is this session's, in case
  a `/clear` or a switch of session changed the session id. It reads the
  prompt not at all, and passes it on unchanged.
- **`command.run`**, matched to `command: "checklist"` only. It answers
  `/checklist` itself and never sees or changes any other command, whether a
  person typed it or another plugin ran it.
- **`tool.call`**, matched to `tool: "mcp__checklist__checklist"` only. That
  tool is the plugin's own, registered by this module, and no other code
  serves it, so the hook answers the call in place of a tool: it is the
  tool. It stands in for no built-in or MCP tool and never sees a call to
  one.
- **`ui.render`** for the `Pane` with the id `checklist`: draws the pane
  from the live list. Also for the `ToolUse` row and `ToolResult` block of
  a call to its own tool, matched to `tool: "mcp__checklist__checklist"`
  only: draws each as one line, and hands the expanded view (ctrl+o) and
  errors back to the engine. It draws nothing else.

The plugin reads and writes only its own store, under one key per session,
and its own state value; `/checklist version` also reads its own
`.claude-plugin/plugin.json`. It makes no network requests and runs no
processes.

## Developing

```
claude plugin validate <this folder>
claude plugin test <this folder>
```
