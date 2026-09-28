import { AuditLogger } from "../core/audit.js";
import { EventBus, type ForemanEventMap } from "../core/event-bus.js";
import { createIntegrationWiring, type IntegrationWiring } from "../core/integrations/wiring.js";
import type { SecretStore } from "../core/secret-store.js";
import type { ForemanDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";

/**
 * The setup wizard's IntegrationService (`foreman setup` and the wizard
 * `foreman start` opens on a fresh home). Its audit events go to
 * audit_events through an AuditLogger on a private bus, so the wizard does
 * not start auditing every other bus event. Call `dispose()` once the
 * wizard exits: it flushes what is queued.
 *
 * When the bundled catalog can't be loaded the wizard still runs; its
 * Integrations step then says integrations are unavailable.
 */
export function wizardIntegrations(
  db: ForemanDb,
  store: SecretStore,
): { integrations?: IntegrationWiring; dispose: () => void } {
  const audit = new AuditLogger(db, new EventBus<ForemanEventMap>());
  const dispose = (): void => audit.dispose();
  try {
    return { integrations: createIntegrationWiring({ paths: getForemanPaths(), store, audit }), dispose };
  } catch {
    return { dispose };
  }
}
