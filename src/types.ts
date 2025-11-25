import {
    type AgentDefinition,
    type SDKMessage,
    type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

// WebSocket message types
export type WSInputMessage =
    | {
        type: 'user_message'
        data: SDKUserMessage
    }
    | { type: 'interrupt' }
    | {
        type: 'create_file'
        path: string
        content: string
        encoding?: 'utf-8' | 'base64'
    }
    | { type: 'read_file'; path: string; encoding?: 'utf-8' | 'base64' }
    | { type: 'delete_file'; path: string }
    | { type: 'list_files'; path?: string }

export type WSOutputMessage =
    | { type: 'connected' }
    | { type: 'sdk_message'; data: SDKMessage }
    | { type: 'error'; error: string }
    | { type: 'info'; data: string }
    | {
        type: 'file_result'
        operation: 'create_file' | 'delete_file'
        result: 'success'
    }
    | {
        type: 'file_result'
        operation: 'read_file'
        result: string
        encoding: 'utf-8' | 'base64'
    }
    | { type: 'file_result'; operation: 'list_files'; result: string[] }

// Configuration type for the query options
export type QueryConfig = {
    agents?: Record<string, AgentDefinition>
    allowedTools?: string[]
    systemPrompt?:
    | string
    | {
        type: 'preset'
        preset: 'claude_code'
        append?: string
    }
    model?: string
    anthropicApiKey?: string
    resume?: string  // Session ID to resume
}
