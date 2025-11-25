import { readdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { type ServerWebSocket } from 'bun'

import { type WSInputMessage, type WSOutputMessage } from './types'

export type MessageHandlerContext = {
    messageQueue: SDKUserMessage[]
    getActiveStream: () => ReturnType<typeof query> | null
    workspaceDirectory: string
}

export async function handleMessage(
    ws: ServerWebSocket,
    message: string | Buffer,
    context: MessageHandlerContext,
) {
    try {
        const input = JSON.parse(message.toString()) as WSInputMessage
        const { messageQueue, getActiveStream, workspaceDirectory } = context

        if (input.type === 'user_message') {
            messageQueue.push(input.data)
        } else if (input.type === 'interrupt') {
            getActiveStream()?.interrupt()
        } else if (input.type === 'create_file') {
            const targetPath = join(workspaceDirectory, input.path)
            const encoding = input.encoding || 'utf-8'
            const content =
                encoding === 'base64'
                    ? Buffer.from(input.content, 'base64')
                    : input.content

            try {
                await writeFile(targetPath, content)
                ws.send(
                    JSON.stringify({
                        type: 'file_result',
                        operation: 'create_file',
                        result: 'success',
                    } as WSOutputMessage),
                )
            } catch (err) {
                ws.send(
                    JSON.stringify({
                        type: 'error',
                        error: `Failed to create file: ${err instanceof Error ? err.message : String(err)}`,
                    } as WSOutputMessage),
                )
            }
        } else if (input.type === 'read_file') {
            const targetPath = join(workspaceDirectory, input.path)
            const encoding = input.encoding || 'utf-8'

            try {
                const content = await readFile(
                    targetPath,
                    encoding === 'base64' ? 'base64' : 'utf-8',
                )
                ws.send(
                    JSON.stringify({
                        type: 'file_result',
                        operation: 'read_file',
                        result: content,
                        encoding,
                    } as WSOutputMessage),
                )
            } catch (err) {
                ws.send(
                    JSON.stringify({
                        type: 'error',
                        error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
                    } as WSOutputMessage),
                )
            }
        } else if (input.type === 'delete_file') {
            const targetPath = join(workspaceDirectory, input.path)
            try {
                await unlink(targetPath)
                ws.send(
                    JSON.stringify({
                        type: 'file_result',
                        operation: 'delete_file',
                        result: 'success',
                    } as WSOutputMessage),
                )
            } catch (err) {
                ws.send(
                    JSON.stringify({
                        type: 'error',
                        error: `Failed to delete file: ${err instanceof Error ? err.message : String(err)}`,
                    } as WSOutputMessage),
                )
            }
        } else if (input.type === 'list_files') {
            const targetPath = input.path
                ? join(workspaceDirectory, input.path)
                : workspaceDirectory
            try {
                const files = await readdir(targetPath)
                ws.send(
                    JSON.stringify({
                        type: 'file_result',
                        operation: 'list_files',
                        result: files,
                    } as WSOutputMessage),
                )
            } catch (err) {
                ws.send(
                    JSON.stringify({
                        type: 'error',
                        error: `Failed to list files: ${err instanceof Error ? err.message : String(err)}`,
                    } as WSOutputMessage),
                )
            }
        }
    } catch (error) {
        ws.send(
            JSON.stringify({
                type: 'error',
                error: `Invalid message format: ${error instanceof Error ? error.message : String(error)}`,
            } as WSOutputMessage),
        )
    }
}
