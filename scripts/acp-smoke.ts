import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { z } from 'zod';
import { AcpAgent, stopAcpSessions } from '../src/server/acp-agent.js';
import {
  localAgentConfigFromEnv,
  type PlatformConfig,
} from '../src/server/platform-config.js';

const config: PlatformConfig = {
  ...localAgentConfigFromEnv({
    ...process.env,
    AGENT_BACKEND: 'acp',
    THREAD_STORAGE: 'local',
  }),
  baseUrl: '',
  runtimeUrl: '',
  voiceName: 'marin',
  slackUsers: [],
};
const code = randomUUID();
const threadId = randomUUID();
let calls = 0;
const agent = new AcpAgent(
  config,
  {
    key: threadId,
    prompt:
      'You are an OpenDots assistant. Use the supplied application tools when the user asks.',
    check: () => {},
    maxSteps: 3,
    tools: [
      {
        name: 'opendots_probe',
        description: 'Get the verification code. It cannot be guessed.',
        parameters: z.object({}),
        execute: async () => {
          calls++;
          return { code };
        },
      },
    ],
  },
  'probe',
);
const timeout = setTimeout(() => agent.abortRun(), 180_000);
timeout.unref();
function input(messages: RunAgentInput['messages']): RunAgentInput {
  return {
    threadId,
    runId: randomUUID(),
    messages,
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
}
function text(events: BaseEvent[]) {
  return events
    .flatMap((event) =>
      event.type === EventType.TEXT_MESSAGE_CONTENT ? [event.delta] : [],
    )
    .join('');
}
try {
  const first = await lastValueFrom(
    agent
      .run(
        input([
          {
            id: randomUUID(),
            role: 'user',
            content: 'Call opendots_probe and quote its verification code.',
          },
        ]),
      )
      .pipe(toArray()),
  );
  assert.equal(
    first.some((event) => event.type === EventType.RUN_ERROR),
    false,
    JSON.stringify(first),
  );
  assert.ok(calls > 0, 'Provider did not call the application tool.');
  assert.ok(
    text(first).includes(code),
    'Provider did not quote the actual tool result.',
  );
  const second = await lastValueFrom(
    agent
      .run(
        input([
          {
            id: randomUUID(),
            role: 'user',
            content:
              'Which fictional verification code did the OpenDots tool return earlier? Answer with that tool result.',
          },
        ]),
      )
      .pipe(toArray()),
  );
  assert.equal(
    second.some((event) => event.type === EventType.RUN_ERROR),
    false,
    JSON.stringify(second),
  );
  assert.ok(
    text(second).includes(code),
    `ACP did not retain the conversation session: ${JSON.stringify(second)}`,
  );
  console.log(
    `${config.acpProvider}: real OpenDots tool round trip and session reuse verified.`,
  );
} finally {
  clearTimeout(timeout);
  await stopAcpSessions(config);
}
