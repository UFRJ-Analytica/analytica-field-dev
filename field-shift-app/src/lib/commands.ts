import { z } from 'zod'
import type { ZodType } from 'zod'
import { useMapStore } from './map-store'

export const COMMAND_EFFECTS = [
  'select_field',
  'set_composition',
  'open_panel',
  'apply_filter',
] as const

export type CommandEffect = (typeof COMMAND_EFFECTS)[number]

type CommandDefinition<Name extends string, Schema extends ZodType> = {
  name: Name
  label: string
  schema: Schema
  effect: CommandEffect
  idempotent: boolean
  guard: string
}

type AnyCommand = CommandDefinition<string, ZodType>

const commandRegistry = new Map<string, AnyCommand>()

export class UnknownCommandError extends Error {
  readonly status = 422
  readonly validNames: string[]

  constructor(name: string) {
    const validNames = listCommands().map(({ name: commandName }) => commandName)
    super(`Unknown command "${name}". Valid commands: ${validNames.join(', ')}`)
    this.name = 'UnknownCommandError'
    this.validNames = validNames
  }
}

export function registerCommand<Name extends string, Schema extends ZodType>(
  command: CommandDefinition<Name, Schema>,
): void {
  if (!COMMAND_EFFECTS.includes(command.effect)) {
    throw new Error(`Unsupported command effect: ${String(command.effect)}`)
  }
  if (commandRegistry.size >= COMMAND_EFFECTS.length) {
    throw new Error(`Only these four command effects are supported: ${COMMAND_EFFECTS.join(', ')}`)
  }
  if (commandRegistry.has(command.name)) {
    throw new Error(`Command already registered: ${command.name}`)
  }
  commandRegistry.set(command.name, command)
}

const commands: CommandDefinition<string, ZodType>[] = [
  {
    name: 'select_field',
    label: 'Select a field',
    schema: z.object({ field_id: z.string().min(1) }).strict(),
    effect: 'select_field',
    idempotent: false,
    guard: 'field_id must identify a fixture field, a trazo: polygon id, a csb: field id or a registered field of R-40',
  },
  {
    name: 'set_composition',
    label: 'Set map composition',
    schema: z.object({ preset: z.enum(['map', 'satellite', 'satellite-with-labels']) }).strict(),
    effect: 'set_composition',
    idempotent: true,
    guard: 'preset must be a supported map composition',
  },
  {
    name: 'open_panel',
    label: 'Open a panel',
    schema: z.object({ panel: z.enum(['scenarios', 'evidence']) }).strict(),
    effect: 'open_panel',
    idempotent: true,
    guard: 'panel must be one of the available workspace panels',
  },
  {
    name: 'apply_filter',
    label: 'Apply a scenario filter',
    schema: z.object({ filter: z.enum(['all', 'ranked', 'abstained']) }).strict(),
    effect: 'apply_filter',
    idempotent: false,
    guard: 'filter must be all, ranked, or abstained',
  },
]

for (const command of commands) registerCommand(command)

export function listCommands(): AnyCommand[] {
  return Array.from(commandRegistry.values())
}

export function runCommand(name: string, input: unknown): unknown {
  const command = commandRegistry.get(name)
  if (!command) throw new UnknownCommandError(name)
  const arguments_ = command.schema.parse(input) as Record<string, unknown>
  const store = useMapStore.getState()

  switch (command.effect) {
    case 'select_field':
      store.selectField(arguments_.field_id as string)
      break
    case 'set_composition':
      store.setComposition(arguments_.preset as 'map' | 'satellite' | 'satellite-with-labels')
      break
    case 'open_panel':
      store.openPanel(arguments_.panel as 'scenarios' | 'evidence')
      break
    case 'apply_filter':
      store.applyFilter(arguments_.filter as 'all' | 'ranked' | 'abstained')
      break
  }
  return { name: command.name, effect: command.effect, arguments: arguments_ }
}

export function commandInputSchema(command: AnyCommand): Record<string, unknown> {
  return command.schema.toJSONSchema() as Record<string, unknown>
}
