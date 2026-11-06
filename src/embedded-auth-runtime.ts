import {
  runCapturedServiceTicketDiAuthSetup,
  type BrowserDiAuthCanaryHttp,
  type CapturedServiceTicketDiAuthSetupOptions,
} from './browser-auth-canary'
import { createAxiosCanaryHttpAdapter } from './browser-auth-canary-runtime'
import {
  reportAuthDiagnostic,
  type AuthDiagnosticReporter,
} from './auth-diagnostics'
import type { GarminRegion } from './config'
import {
  createCdpBrowserLauncher,
  type CdpBrowserLauncher,
} from './cdp-browser'
import { EmbeddedAuthController } from './embedded-auth-controller'
import { EmbeddedAuthFlowManager } from './embedded-auth-flow'
import { EmbeddedAuthServer } from './embedded-auth-server'
import {
  prepareSessionTokenWriteDestination,
  writeSessionTokenFile,
  type GarminDiSessionFile,
} from './session-store'

export interface EmbeddedAuthRuntimeConfig {
  username: string
  region: GarminRegion
  sessionTokenFile: string
}

export interface EmbeddedAuthRuntimeOptions {
  http?: BrowserDiAuthCanaryHttp
  writeSession?: (
    path: string,
    session: GarminDiSessionFile,
  ) => Promise<void>
  replaceSession?: (writeSession: () => Promise<void>) => Promise<void>
  prepareDestination?: (path: string) => Promise<void>
  diagnostics?: AuthDiagnosticReporter
  /** Internal seam; production owns a fresh isolated Chromium CDP session. */
  cdpBrowser?: CdpBrowserLauncher
}

/**
 * Assemble the shared loopback authentication runtime.
 *
 * This seam intentionally has no Cordis dependency. It prepares a CDP launcher
 * but starts no browser unless the Host receives an explicit `begin-cdp` call;
 * the default embedded, CLI, and MCP transports keep their existing behavior.
 */
export function createEmbeddedAuthController(
  config: EmbeddedAuthRuntimeConfig,
  options: EmbeddedAuthRuntimeOptions = {},
): EmbeddedAuthController {
  const http = options.http ?? createAxiosCanaryHttpAdapter()
  const persistSession = options.writeSession ?? writeSessionTokenFile
  const prepareDestination = options.prepareDestination
    ?? prepareSessionTokenWriteDestination
  const flows = new EmbeddedAuthFlowManager({
    authenticate: async (input) => {
      await runCapturedServiceTicketDiAuthSetup(
        {
          region: input.region,
          username: input.username,
          sessionTokenFile: input.sessionTokenFile,
          serviceTicket: input.ticket.serviceTicket,
          serviceUrl: input.ticket.serviceUrl,
          loopbackOrigin: input.loopbackOrigin,
          signal: input.signal,
          confirmIdentity: input.confirmIdentity,
          onStage: stage => {
            // The flow manager owns the ticket transition so it is reported
            // once. The DI/profile stages come from this credential-free seam.
            if (stage !== 'ticket_captured') {
              reportAuthDiagnostic(options.diagnostics, stage)
            }
          },
        } satisfies CapturedServiceTicketDiAuthSetupOptions,
        {
          http,
          writeSession: (path, session) => {
            const commit = () => persistSession(path, session)
            return options.replaceSession
              ? options.replaceSession(commit)
              : commit()
          },
        },
      )
    },
    diagnostics: options.diagnostics,
  })
  const server = new EmbeddedAuthServer(flows)
  return new EmbeddedAuthController({
    ...config,
    flows,
    server,
    prepareDestination,
    diagnostics: options.diagnostics,
    cdpBrowser: options.cdpBrowser ?? createCdpBrowserLauncher(),
  })
}
