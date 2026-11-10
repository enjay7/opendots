// Real JSON-RPC ACP and stdio MCP transports, with no model or account access.
import { createInterface } from 'node:readline';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
let session;
let client;
let turn = 0;
let permission;
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const reply = (id, result) => send({ id, result });
const text = (value) =>
  send({
    method: 'session/update',
    params: {
      sessionId: 'fixture',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: value },
      },
    },
  });
process.once('SIGTERM', () => {
  void Promise.resolve(client?.close()).finally(() => process.exit(0));
});
createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (!message.method && message.id === 'permission') {
    permission?.(message.result);
    return;
  }
  try {
    if (message.method === 'initialize')
      reply(message.id, {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
      });
    else if (message.method === 'session/new') {
      session = message.params;
      reply(message.id, { sessionId: 'fixture' });
    } else if (message.method === 'session/prompt') {
      turn++;
      if (process.argv.includes('--hang')) return;
      if (process.argv.includes('--api-error')) {
        text('API Error: fictional provider service failure.');
        reply(message.id, { stopReason: 'end_turn' });
        return;
      }
      text(
        `process:${process.pid};turn:${turn};app-secret:${!!process.env.OWNER_TOKEN}; `,
      );
      text(
        `app-secrets-present:${['OWNER_TOKEN', 'OPENAI_API_KEY', 'COMPOSIO_API_KEY', 'COMPUTER_TOKEN', 'INTELLIGENCE_API_KEY'].some((name) => !!process.env[name])};auth-preserved:${process.env.AWS_PROFILE === 'fixture' && process.env.ANTHROPIC_AUTH_TOKEN === 'fictional-cli-auth'}; `,
      );
      if (process.argv.includes('--permission')) {
        const outcome = await new Promise((resolve) => {
          permission = resolve;
          send({
            id: 'permission',
            method: 'session/request_permission',
            params: {
              sessionId: 'fixture',
              toolCall: {
                toolCallId: 'native',
                title: 'opendots_probe',
                status: 'pending',
                kind: 'execute',
              },
              options: [
                { kind: 'allow_once', optionId: 'allow', name: 'Allow' },
              ],
            },
          });
        });
        text(`permission:${outcome.outcome.outcome}; `);
      }
      const prompt = message.params.prompt[0].text;
      if (
        process.argv.includes('--review') &&
        prompt.includes('"role":"tool"')
      ) {
        text('Review result received.');
        reply(message.id, { stopReason: 'end_turn' });
        return;
      }
      const server = session.mcpServers[0];
      if (process.argv.includes('--unauthorized')) {
        const environment = Object.fromEntries(
          server.env.map((item) => [item.name, item.value]),
        );
        const response = await globalThis.fetch(
          `${environment.OPENDOTS_TOOL_URL}/list`,
          {
            method: 'POST',
            headers: { Authorization: 'Bearer wrong-token' },
          },
        );
        text(`unauthorized:${response.status}; `);
      }
      client = new Client({ name: 'fixture', version: '1.0' });
      await client.connect(
        new StdioClientTransport({
          command: server.command,
          args: server.args,
          env: {
            ...process.env,
            ...Object.fromEntries(
              server.env.map((item) => [item.name, item.value]),
            ),
          },
          stderr: 'ignore',
        }),
      );
      const { tools } = await client.listTools();
      let name = tools.some((tool) => tool.name === 'opendots_probe')
        ? 'opendots_probe'
        : 'list_authorized_spaces';
      let args = {};
      if (process.argv.includes('--review')) {
        name = 'review_space_page';
        args = {
          title: 'Fixture draft',
          content: 'Fictional reviewed document',
          spaceId: 'fixture-space',
        };
      }
      if (process.argv.includes('--invalid')) args = { unexpected: true };
      const result = await client.callTool({ name, arguments: args });
      text(JSON.stringify(result));
      await client.close();
      reply(message.id, { stopReason: 'end_turn' });
    }
  } catch {
    send({
      id: message.id,
      error: { code: -32603, message: 'Fixture request failed.' },
    });
  }
});
