# @castari/sdk

The SDK for building and connecting to Castari agents running in secure cloud sandboxes.

## Installation

```bash
npm install @castari/sdk
# or
bun add @castari/sdk
```

## Building Agents

### `serve(options)`

Starts the agent server. This should be the entrypoint of your agent.

```typescript
import { serve, tool } from '@castari/sdk'

serve({
  tools: [myTool],
  systemPrompt: 'You are a helpful assistant.'
})
```

#### Options

| Property | Type | Description |
|----------|------|-------------|
| `tools` | `Tool[]` | Array of tools exposed by the agent |
| `systemPrompt` | `string` | The system prompt defining the agent's behavior |
| `allowedTools` | `string[]` | (Optional) Restrict which tools the agent can use |
| `port` | `number` | (Optional) Port to listen on. Defaults to `3000` |

By default, agents have access to all system tools (Bash, File Editing, etc.) plus any custom tools you define. Use `allowedTools` to restrict access:

```typescript
serve({
  tools: [myCustomTool],
  allowedTools: ['my_custom_tool', 'Bash'] // Only these tools available
})
```

### `tool(definition)`

Defines a custom tool for the agent.

```typescript
import { tool } from '@castari/sdk'

const weatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a location',
  inputSchema: {
    type: 'object',
    properties: {
      location: { type: 'string' }
    },
    required: ['location']
  },
  handler: async ({ location }) => {
    return `The weather in ${location} is sunny.`
  }
})
```

## Connecting to Agents

### `CastariClient`

A client for connecting to Castari agents running in cloud sandboxes.

```typescript
import { CastariClient } from '@castari/sdk/client'

const client = new CastariClient({
  snapshot: 'my-agent',
  clientId: process.env.CASTARI_CLIENT_ID,
  platformApiKey: process.env.CASTARI_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
})

await client.start()

client.onMessage((msg) => {
  if (msg.type === 'assistant_message') {
    console.log('Agent:', msg.data.message)
  }
})

client.send({
  type: 'user_message',
  data: { message: 'Hello!' }
})

// When done
await client.stop()
```

#### Constructor Options

| Property | Type | Description |
|----------|------|-------------|
| `snapshot` | `string` | Name of the deployed snapshot to use |
| `clientId` | `string` | Your Castari client ID |
| `platformApiKey` | `string` | Your Castari API key |
| `anthropicApiKey` | `string` | Your Anthropic API key |
| `volume` | `string` | (Optional) Volume name for persistent storage |
| `labels` | `Record<string, string>` | (Optional) Labels for sandbox reuse |
| `resume` | `string` | (Optional) Session ID to resume a previous conversation |
| `connectionUrl` | `string` | (Optional) Direct URL for local development |
| `platformUrl` | `string` | (Optional) Override the platform URL |
| `useProxy` | `boolean` | (Optional) Use platform proxy. Defaults to `true` |
| `debug` | `boolean` | (Optional) Enable debug logging |

#### Methods

- `start()` - Creates a sandbox and connects to the agent
- `stop(options?)` - Disconnects and cleans up
  - `{ delete: false }` - Stop but preserve sandbox for reuse
  - `{ delete: true }` (default) - Delete the sandbox
- `send(message)` - Send a message to the agent
- `onMessage(callback)` - Register a callback for incoming messages

### Message Types

#### Input Messages (client to agent)

```typescript
// Send a user message
client.send({
  type: 'user_message',
  data: { message: 'Hello!' }
})
```

#### Output Messages (agent to client)

```typescript
client.onMessage((msg) => {
  switch (msg.type) {
    case 'connected':
      // Connection established
      break
    case 'assistant_message':
      // Text response from the agent
      console.log(msg.data.message)
      break
    case 'tool_use':
      // Agent is using a tool
      console.log(`Using tool: ${msg.data.name}`)
      break
    case 'tool_result':
      // Tool execution result
      break
    case 'done':
      // Agent finished processing
      break
    case 'error':
      // Error occurred
      console.error(msg.data.error)
      break
  }
})
```

### Sandbox Reuse

Use labels to reuse sandboxes across sessions:

```typescript
const client = new CastariClient({
  snapshot: 'my-agent',
  volume: `user-${userId}`,
  labels: {
    userId,
    app: 'my-app'
  }
})

// First call creates, subsequent calls reuse the same sandbox
await client.start()

// Stop but preserve for later
await client.stop({ delete: false })
```

### Session Resumption

Resume a previous conversation:

```typescript
// Store the session ID from a previous session
const sessionId = previousSessionId

const client = new CastariClient({
  snapshot: 'my-agent',
  resume: sessionId
})

await client.start()
// Conversation continues where it left off
```

### Local Development

Connect directly to a local agent server:

```typescript
const client = new CastariClient({
  connectionUrl: 'http://localhost:3000',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY
})

await client.start()
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `CASTARI_CLIENT_ID` | Your Castari client ID |
| `CASTARI_API_KEY` | Your Castari API key |

## License

MIT
