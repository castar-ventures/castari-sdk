import type { QueryConfig, WSInputMessage, WSOutputMessage } from './types'

export * from './types'

const DEFAULT_LOCAL_URL = 'http://localhost:3000'
const DEFAULT_PLATFORM_URL = 'https://castari-api-12511-04c55b73-g4p2s9om.onporter.run'

/**
 * Configuration options for the Castari Client.
 */
export interface ClientOptions extends Partial<QueryConfig> {
    /** Local/custom connection URL (e.g., 'http://localhost:3000'). If omitted, Platform mode is used. */
    connectionUrl?: string
    /** Anthropic API key (required unless present in process.env.ANTHROPIC_API_KEY) */
    anthropicApiKey?: string
    /** Castari client ID (required for platform mode; otherwise read from env) */
    clientId?: string
    /** Castari platform API key (used for auth when contacting the platform) */
    platformApiKey?: string
    /** Enable debug logging */
    debug?: boolean

    /** Snapshot name to deploy/start */
    snapshot?: string

    /** Optional labels to apply to the sandbox (and filter by for reuse) */
    labels?: Record<string, string>

    /** Optional volume name to mount at /home/castari/agent-workspace */
    volume?: string

    /** Castari Platform API URL. Defaults to https://api.castari.com (or localhost in dev) */
    platformUrl?: string

    /** Optional sessionId to resume */
    resume?: string

    /**
     * Use the platform API as a WebSocket proxy instead of connecting directly to the sandbox.
     * Defaults to true for reliability. Set to false to connect directly to the sandbox.
     */
    useProxy?: boolean
}

type ConnectionDetails = {
    configUrl: string
    wsUrl: string
    /** Headers to include in HTTP requests (e.g., for sandbox proxy auth) */
    authHeaders?: Record<string, string>
    /** Query params to include in WebSocket URL (browsers can't set WS headers) */
    authParams?: Record<string, string>
    cleanup?: () => Promise<void>
}

export class CastariClient {
    private ws?: WebSocket
    private options: ClientOptions
    private messageHandlers: ((message: WSOutputMessage) => void)[] = []
    private sandboxId?: string
    private resolvedClientId?: string
    private resolvedPlatformApiKey?: string

    constructor(options: ClientOptions = {}) {
        this.options = {
            ...options,
        }
    }

    async start() {
        const anthropicApiKey =
            this.options.anthropicApiKey || process.env.ANTHROPIC_API_KEY
        if (!anthropicApiKey) {
            throw new Error('ANTHROPIC_API_KEY is required')
        }

        this.resolvedClientId =
            this.options.clientId || process.env.CASTARI_CLIENT_ID || undefined
        this.resolvedPlatformApiKey =
            this.options.platformApiKey || process.env.CASTARI_API_KEY || undefined

        const connection = this.options.connectionUrl
            ? await this.setupLocalConnection()
            : await this.setupPlatformConnection()

        if (this.options.debug) {
            console.log(`📡 Configuring server at ${connection.configUrl}...`)
        }

        const configPayload: QueryConfig & { anthropicApiKey: string } = {
            anthropicApiKey,
            agents: this.options.agents,
            allowedTools: this.options.allowedTools,
            systemPrompt: this.options.systemPrompt,
            model: this.options.model,
            resume: this.options.resume,
        }

        if (this.options.debug) {
            console.log(`📋 Config payload:`, JSON.stringify(configPayload, null, 2))
        }

        const configHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            ...connection.authHeaders,
        }

        let configResponse: Response | null = null
        const maxConfigAttempts = 5
        for (let attempt = 1; attempt <= maxConfigAttempts; attempt++) {
            configResponse = await fetch(connection.configUrl, {
                method: 'POST',
                headers: configHeaders,
                body: JSON.stringify(configPayload),
            }).catch(err => {
                if (this.options.debug) {
                    console.warn(`⚠️ Config request failed on attempt ${attempt}:`, err)
                }
                return null
            })

            if (configResponse && configResponse.ok) break

            if (this.options.debug) {
                console.warn(
                    `⚠️ Config attempt ${attempt} failed (status ${configResponse?.status ?? 'n/a'}).`,
                )
            }
            if (attempt < maxConfigAttempts) {
                await new Promise(resolve => setTimeout(resolve, 3000))
            }
        }

        if (!configResponse || !configResponse.ok) {
            const errorText = configResponse ? await configResponse.text() : 'no response'
            if (connection.cleanup) await connection.cleanup()
            throw new Error(
                `Failed to configure server (status ${configResponse?.status ?? 'n/a'}): ${errorText}`,
            )
        }

        const { connectionToken } = (await configResponse.json()) as {
            connectionToken: string
        }

        if (!connectionToken) {
            if (connection.cleanup) await connection.cleanup()
            throw new Error('Server did not return a connectionToken')
        }

        const wsUrlParams = new URLSearchParams()
        wsUrlParams.set('token', connectionToken)
        // Add any auth params from platform (for sandbox proxy auth)
        if (connection.authParams) {
            for (const [key, value] of Object.entries(connection.authParams)) {
                wsUrlParams.set(key, value)
            }
        }

        const wsUrlJoiner = connection.wsUrl.includes('?') ? '&' : '?'
        const wsUrl = `${connection.wsUrl}${wsUrlJoiner}${wsUrlParams.toString()}`

        if (this.options.debug) {
            console.log(`🔌 Connecting to WebSocket at ${wsUrl}...`)
        }

        return new Promise<void>((resolve, reject) => {
            this.ws = new WebSocket(wsUrl)

            this.ws.onopen = () => {
                if (this.options.debug) console.log('✅ Connected to Castari Server')
                resolve()
            }

            this.ws.onmessage = event => {
                try {
                    const message = JSON.parse(event.data.toString()) as WSOutputMessage
                    this.handleMessage(message)
                } catch (error) {
                    console.error('Failed to parse message:', error)
                }
            }

            this.ws.onerror = error => {
                console.error('WebSocket error:', error)
                reject(error)
            }

            this.ws.onclose = () => {
                if (this.options.debug) console.log('👋 Disconnected')
            }
        })
    }

    private async setupLocalConnection(): Promise<ConnectionDetails> {
        const baseUrl = (this.options.connectionUrl || DEFAULT_LOCAL_URL).replace(
            /\/$/,
            '',
        )
        return {
            configUrl: `${baseUrl.replace('ws://', 'http://').replace('wss://', 'https://')}/config`,
            wsUrl: `${baseUrl.replace('http://', 'ws://').replace('https://', 'wss://')}/ws`,
        }
    }

    private async setupPlatformConnection(): Promise<ConnectionDetails> {
        if (!this.resolvedClientId) {
            throw new Error('CASTARI_CLIENT_ID is required when connecting via the Castari Platform')
        }
        const platformUrl = (this.options.platformUrl || process.env.CASTARI_PLATFORM_URL || DEFAULT_PLATFORM_URL).replace(/\/$/, '')

        if (this.options.debug) {
            console.log(`🚀 Requesting sandbox from ${platformUrl}...`)
        }

        const response = await fetch(`${platformUrl}/sandbox/start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(this.resolvedPlatformApiKey
                    ? { Authorization: `Bearer ${this.resolvedPlatformApiKey}` }
                    : {}),
            },
            body: JSON.stringify({
                snapshot: this.options.snapshot,
                labels: this.options.labels,
                volume: this.options.volume,
                clientId: this.resolvedClientId
            })
        })

        if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`Failed to start sandbox: ${errorText}`)
        }

        const { id, url, proxyUrl, authHeaders, authParams } = await response.json() as {
            id: string
            url: string
            proxyUrl?: string
            authHeaders?: Record<string, string>
            authParams?: Record<string, string>
        }
        this.sandboxId = id

        // Default to proxy mode (true) unless explicitly disabled
        const useProxy = this.options.useProxy ?? (process.env.CASTARI_USE_PROXY !== 'false')

        if (this.options.debug) {
            console.log(`✅ Sandbox started: ${id} at ${url}`)
            if (useProxy && proxyUrl) {
                console.log(`🔀 Using proxy mode via ${proxyUrl}`)
            }
        }

        // If proxy mode is enabled and we have a proxy URL, use it
        if (useProxy && proxyUrl) {
            // Proxy mode: connect through platform API
            const proxyConfigUrl = `${platformUrl}/proxy/${id}/config`
            const proxyWsUrl = proxyUrl

            return {
                configUrl: proxyConfigUrl,
                wsUrl: proxyWsUrl,
                // No auth headers/params needed - proxy handles sandbox auth
                cleanup: async () => {
                    await this.stop({ delete: true })
                }
            }
        }

        // Direct mode: connect to sandbox directly
        const baseUrl = url.replace(/\/$/, '')
        const configUrl = `${baseUrl.replace('ws://', 'http://').replace('wss://', 'https://')}/config`
        const wsUrlBase = `${baseUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/ws`

        return {
            configUrl,
            wsUrl: wsUrlBase,
            authHeaders,
            authParams,
            cleanup: async () => {
                await this.stop({ delete: true })
            }
        }
    }

    private handleMessage(message: WSOutputMessage) {
        if (this.options.debug) {
            console.log('📨 Received message:', JSON.stringify(message, null, 2))
        }
        this.messageHandlers.forEach(handler => handler(message))
    }

    onMessage(handler: (message: WSOutputMessage) => void) {
        this.messageHandlers.push(handler)
        return () => {
            this.messageHandlers = this.messageHandlers.filter(h => h !== handler)
        }
    }

    send(message: WSInputMessage) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket is not connected')
        }
        this.ws.send(JSON.stringify(message))
    }

    async stop(options: { delete?: boolean } = { delete: true }) {
        if (this.ws) {
            this.ws.close()
        }

        if (this.sandboxId) {
            const platformUrl = (this.options.platformUrl || process.env.CASTARI_PLATFORM_URL || DEFAULT_PLATFORM_URL).replace(/\/$/, '')
            try {
                const clientId = this.resolvedClientId || this.options.clientId || process.env.CASTARI_CLIENT_ID
                const apiKey = this.resolvedPlatformApiKey || this.options.platformApiKey || process.env.CASTARI_API_KEY
                const response = await fetch(`${platformUrl}/sandbox/stop`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                    },
                    body: JSON.stringify({
                        sandboxId: this.sandboxId,
                        delete: options.delete,
                        clientId
                    })
                })

                if (!response.ok) {
                    console.error(`Failed to stop sandbox: ${await response.text()}`)
                } else if (this.options.debug) {
                    console.log(`🛑 Sandbox ${options.delete ? 'deleted' : 'stopped'}`)
                }
            } catch (err) {
                console.error('Failed to call stop endpoint:', err)
            }
        }
    }
}
