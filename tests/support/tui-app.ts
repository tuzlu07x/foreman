import React from 'react'
import { render } from 'ink-testing-library'
import type Database from 'better-sqlite3'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { InboxService } from '../../src/core/inbox.js'
import { RegistryService } from '../../src/core/registry.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { App } from '../../src/tui/app.js'
import type { DashboardServices } from '../../src/tui/dashboard-context.js'

// Mounts the whole TUI on an in-memory database, past the boot splash, for
// tests that drive it with real keystrokes.

export const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '')
export const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms))
export const ESC = '\u001B'
export const CTRL_C = '\u0003'

export interface MountedApp {
  app: ReturnType<typeof render>
  db: ForemanDb
  sqlite: Database.Database
  bus: EventBus<ForemanEventMap>
  registry: RegistryService
  frame: () => string
  press: (keys: string, ms?: number) => Promise<void>
  unmount: () => void
}

export interface AppSeed {
  db: ForemanDb
  sqlite: Database.Database
  bus: EventBus<ForemanEventMap>
  registry: RegistryService
}

/** `setup` runs before the first render (register agents, store secrets)
 *  and returns extra services. */
export async function mountApp(
  setup: (seed: AppSeed) => Partial<DashboardServices> = () => ({}),
): Promise<MountedApp> {
  const { db, sqlite } = createInMemoryDb()
  const bus = new EventBus<ForemanEventMap>()
  const registry = new RegistryService(db, bus)
  const extra = setup({ db, sqlite, bus, registry })
  const app = render(
    React.createElement(App, {
      bootInfo: {
        publicKey: Buffer.alloc(32, 1),
        policyRules: 3,
        dbPath: ':memory:',
        gateway: { stdio: true },
        version: '0.0.0-test',
      },
      services: { db, sqlite, bus, registry, inbox: new InboxService(db, bus), keySettleMs: 0, ...extra },
    }),
  )
  await tick()
  app.stdin.write(' ')
  await tick()
  const press = async (keys: string, ms = 60): Promise<void> => {
    app.stdin.write(keys)
    await tick(ms)
  }
  return {
    app,
    db,
    sqlite,
    bus,
    registry,
    frame: () => strip(app.lastFrame()),
    press,
    unmount: () => {
      app.unmount()
      sqlite.close()
    },
  }
}
