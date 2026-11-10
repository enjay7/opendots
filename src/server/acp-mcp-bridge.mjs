import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import process from 'node:process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const endpoint = process.env.OPENDOTS_TOOL_URL;
const token = process.env.OPENDOTS_TOOL_TOKEN;
if (!endpoint || !token)
  throw new Error('Missing OpenDots tool bridge configuration.');
async function request(path, body) {
  const response = await globalThis.fetch(`${endpoint}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`OpenDots tool bridge returned ${response.status}.`);
  return response.json();
}
const server = new Server(
  { name: 'opendots', version: '0.1.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, () => request('list', {}));
server.setRequestHandler(CallToolRequestSchema, (input) =>
  request('call', input.params),
);
await server.connect(new StdioServerTransport());
