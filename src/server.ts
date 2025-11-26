import { randomBytes } from 'crypto'
import { mkdir } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
    query,
    createSdkMcpServer,
    tool,
    type Options,
    type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { type ServerWebSocket } from 'bun'

import {
    CONNECTION_TOKEN_TTL_MS,
    SERVER_PORT,
    WORKSPACE_DIR_NAME,
} from './const'
import { handleMessage } from './message-handler'
import { type QueryConfig, type WSOutputMessage } from './types'

const workspaceDirectory =
    process.env.CASTARI_WORKSPACE || join(homedir(), WORKSPACE_DIR_NAME)

type ConnectionToken = {
    value: string
    createdAt: number
    used: boolean
}

// Single WebSocket connection (only one allowed)
let activeConnection: ServerWebSocket | null = null

// Message queue
const messageQueue: SDKUserMessage[] = []

// Stream reference for interrupts
let activeStream: ReturnType<typeof query> | null = null

// Stored query configuration
let queryConfig: QueryConfig = {}

// Connection tokens
const connectionTokens = new Map<string, ConnectionToken>()

async function ensureWorkspace() {
    await mkdir(workspaceDirectory, { recursive: true })
}

function generateConnectionToken() {
    const value = randomBytes(24).toString('hex')
    const token: ConnectionToken = {
        value,
        createdAt: Date.now(),
        used: false,
    }
    connectionTokens.set(value, token)
    return value
}

function cleanupTokens() {
    const now = Date.now()
    for (const [value, token] of connectionTokens.entries()) {
        if (token.used || now - token.createdAt > CONNECTION_TOKEN_TTL_MS) {
            connectionTokens.delete(value)
        }
    }
}

function validateAndUseToken(value: string | null) {
    cleanupTokens()
    if (!value) return false
    const token = connectionTokens.get(value)
    if (!token) return false
    const isExpired = Date.now() - token.createdAt > CONNECTION_TOKEN_TTL_MS
    if (token.used || isExpired) {
        connectionTokens.delete(value)
        return false
    }
    token.used = true
    connectionTokens.set(value, token)
    return true
}

// Create an async generator that yields messages from the queue
async function* generateMessages() {
    while (true) {
        while (messageQueue.length > 0) {
            const message = messageQueue.shift()
            if (message) {
                yield message
            }
        }
        await new Promise(resolve => setTimeout(resolve, 10))
    }
}

// Process messages from the SDK and send to WebSocket client
async function processMessages(initialOptions: CastariServerOptions) {
    try {
        // Handle custom tools by creating an SDK MCP server
        let mcpServers = initialOptions.mcpServers || {}
        if (initialOptions.tools && initialOptions.tools.length > 0) {
            const sdkServer = createSdkMcpServer({
                name: 'castari-agent',
                version: '1.0.0',
                tools: initialOptions.tools,
            })
            mcpServers = {
                ...mcpServers,
                'castari-agent': sdkServer,
            }
        }

        const options: Options = {
            settingSources: ['local'],
            cwd: workspaceDirectory,
            // Auto-approve tool usage (including file writes) inside the sandbox.
            // Sandboxes are already isolated, so this keeps DX smooth without interactive prompts.
            canUseTool: async (_toolName, input) => ({
                behavior: 'allow',
                updatedInput: input,
            }),
            stderr: data => {
                if (activeConnection) {
                    const output: WSOutputMessage = {
                        type: 'info',
                        data,
                    }
                    activeConnection.send(JSON.stringify(output))
                }
            },
            ...initialOptions, // Merge initial options (tools, systemPrompt, etc.)
            mcpServers, // Override mcpServers with our injected one
            ...queryConfig, // Merge dynamic config from /config endpoint (overrides initial)
            ...(queryConfig.anthropicApiKey || process.env.ANTHROPIC_API_KEY
                ? {
                    env: {
                        PATH: process.env.PATH,
                        ANTHROPIC_API_KEY:
                            queryConfig.anthropicApiKey || process.env.ANTHROPIC_API_KEY,
                    },
                }
                : {}),
        }

        console.info('Starting query with options', {
            ...options,
            prompt: '[generator]', // avoid logging generator internals
        })

        if ((options as any).resume) {
            console.info(`📋 Resuming session: ${(options as any).resume}`)
        } else {
            console.info('📋 Starting new session')
        }

        activeStream = query({
            prompt: generateMessages(),
            options,
        })

        for await (const message of activeStream) {
            if (activeConnection) {
                const output: WSOutputMessage = {
                    type: 'sdk_message',
                    data: message,
                }
                activeConnection.send(JSON.stringify(output))
            }
        }
    } catch (error) {
        console.error('Error processing messages:', error)
        if (activeConnection) {
            const output: WSOutputMessage = {
                type: 'error',
                error: error instanceof Error ? error.message : 'Unknown error',
            }
            activeConnection.send(JSON.stringify(output))
        }
    }
}

export type CastariServerOptions = Partial<Options> & {
    port?: number
    tools?: ReturnType<typeof tool>[]
}

export async function serve(options: CastariServerOptions = {}) {
    await ensureWorkspace()

    // Create WebSocket server
    const server = Bun.serve({
        port: options.port || SERVER_PORT,
        async fetch(req, server) {
            const url = new URL(req.url)

            // Configuration endpoint
            if (url.pathname === '/config' && req.method === 'POST') {
                try {
                    const config = (await req.json()) as QueryConfig
                    queryConfig = config
                    const connectionToken = generateConnectionToken()
                    return Response.json({
                        success: true,
                        config: queryConfig,
                        connectionToken,
                    })
                } catch {
                    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
                }
            }

            // Get current configuration
            if (url.pathname === '/config' && req.method === 'GET') {
                return Response.json({ config: queryConfig })
            }

            // WebSocket endpoint
            if (url.pathname === '/ws') {
                const token = url.searchParams.get('token')
                if (!validateAndUseToken(token)) {
                    return new Response('Unauthorized', { status: 401 })
                }

                if (activeConnection) {
                    return new Response('Server already has an active connection', {
                        status: 409,
                    })
                }

                if (server.upgrade(req)) return
            }

            return new Response('Not Found', { status: 404 })
        },

        websocket: {
            // Keep connection alive as long as sandbox is running
            idleTimeout: 0,
            sendPings: true,

            open(ws) {
                activeConnection = ws

                // Start processing messages when first connection is made
                if (!activeStream) {
                    processMessages(options)
                }

                const output: WSOutputMessage = { type: 'connected' }
                ws.send(JSON.stringify(output))
            },

            async message(ws, message) {
                await handleMessage(ws, message, {
                    messageQueue,
                    getActiveStream: () => activeStream,
                    workspaceDirectory,
                })
            },

            close(ws) {
                if (activeConnection === ws) {
                    activeConnection = null
                }
            },
        },
    })

    console.log(`🚀 Castari Server running on http://localhost:${server.port}`)
    console.log(`   Config endpoint: http://localhost:${server.port}/config`)
    console.log(`   WebSocket endpoint: ws://localhost:${server.port}/ws?token=<token>`)
}
