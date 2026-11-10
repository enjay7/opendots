import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpAgent, verifyEvents } from '@ag-ui/client';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { z } from 'zod';
import { AcpAgent, stopAcpSessions } from '../src/server/acp-agent.js';
import {
  localAgentConfigFromEnv,
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { pageReviewSchema } from '../src/shared/page-review.js';

const configurations: PlatformConfig[] = [];
afterEach(async () => {
  await Promise.all(configurations.splice(0).map(stopAcpSessions));
  vi.unstubAllEnvs();
});
function config(extra: string[] = []): PlatformConfig {
  const value: PlatformConfig = {
    agentBackend: 'acp',
    threadStorage: 'local',
    acpProvider: 'codex',
    acpCommand: process.execPath,
    acpArgs: [
      fileURLToPath(new URL('./fixtures/acp-provider.mjs', import.meta.url)),
      ...extra,
    ],
    agentRunTimeoutMs: 10_000,
    baseUrl: '',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
    webSearchProvider: 'disabled',
  };
  configurations.push(value);
  return value;
}
function input(
  threadId = 'thread',
  messages: RunAgentInput['messages'] = [],
): RunAgentInput {
  return {
    threadId,
    runId: crypto.randomUUID(),
    state: {},
    tools: [],
    context: [],
    messages,
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
function probe(
  configuration: PlatformConfig,
  key = 'thread',
  execute: (args: unknown) => Promise<unknown> = async () => ({
    code: 'fictional-probe',
  }),
) {
  return new AcpAgent(
    configuration,
    {
      key,
      check: () => {},
      maxSteps: 3,
      prompt: 'Protocol test.',
      tools: [
        {
          name: 'opendots_probe',
          description: 'Probe',
          parameters: z.object({}).strict(),
          execute,
        },
      ],
    },
    'probe',
  );
}

it('requires hosted configuration by default but local ACP needs no hosted/model keys', () => {
  expect(setupStatus(config()).missing).toEqual([]);
  expect(
    setupStatus({
      ...config(),
      agentBackend: 'model',
      threadStorage: 'intelligence',
    }).missing,
  ).toHaveLength(3);
  expect(
    localAgentConfigFromEnv({
      AGENT_BACKEND: 'acp',
      THREAD_STORAGE: 'local',
      ACP_PROVIDER: 'claude',
    }).acpProvider,
  ).toBe('claude');
  expect(() => localAgentConfigFromEnv({ ACP_ARGS: '["safe", 1]' })).toThrow(
    'string array',
  );
});

it('filters application credentials without removing normal model authentication', async () => {
  const values = {
    OWNER_TOKEN: 'fictional-app-secret',
    OPENAI_API_KEY: 'fictional-app-model-key',
    COMPOSIO_API_KEY: 'fictional-connector-key',
    COMPUTER_TOKEN: 'fictional-computer-key',
    INTELLIGENCE_API_KEY: 'fictional-hosted-key',
    AWS_PROFILE: 'fixture',
    ANTHROPIC_AUTH_TOKEN: 'fictional-cli-auth',
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
  const events = await lastValueFrom(
    probe(config()).run(input()).pipe(toArray()),
  );
  expect(text(events)).toContain('app-secrets-present:false');
  expect(text(events)).toContain('auth-preserved:true');
});

it('reuses the actual ACP process and session across normal messages', async () => {
  vi.stubEnv('OWNER_TOKEN', 'fictional-app-secret');
  const agent = probe(config());
  const first = await lastValueFrom(
    agent.run(input()).pipe(verifyEvents(), toArray()),
  );
  const second = await lastValueFrom(
    agent
      .run(
        input('thread', [
          { id: 'next', role: 'user', content: 'Another turn' },
        ]),
      )
      .pipe(verifyEvents(), toArray()),
  );
  expect(text(first)).toContain('turn:1;app-secret:false');
  expect(text(second)).toContain('turn:2;app-secret:false');
  expect(text(second).match(/process:(\d+)/)?.[1]).toBe(
    text(first).match(/process:(\d+)/)?.[1],
  );
  expect(
    second.some((event) => event.type === EventType.TOOL_CALL_RESULT),
  ).toBe(true);
});

it('validates tool arguments before running any application effect', async () => {
  const execute = vi.fn(async () => 'effect');
  const events = await lastValueFrom(
    probe(config(['--invalid']), 'thread', execute)
      .run(input())
      .pipe(toArray()),
  );
  expect(execute).not.toHaveBeenCalled();
  expect(
    events.some((event) => event.type === EventType.TOOL_CALL_RESULT),
  ).toBe(false);
});

it('declines native permission requests even when their title impersonates an offered tool', async () => {
  const events = await lastValueFrom(
    probe(config(['--permission']))
      .run(input())
      .pipe(verifyEvents(), toArray()),
  );
  expect(text(events)).toContain('permission:cancelled');
});
it('rejects unauthenticated bridge requests without exposing tools or breaking the active run', async () => {
  const events = await lastValueFrom(
    probe(config(['--unauthorized']))
      .run(input())
      .pipe(verifyEvents(), toArray()),
  );
  expect(text(events)).toContain('unauthorized:401');
  expect(
    events.some((event) => event.type === EventType.TOOL_CALL_RESULT),
  ).toBe(true);
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

it('does not mark provider API failures as successful conversation or scheduled results', async () => {
  const events = await lastValueFrom(
    probe(config(['--api-error']))
      .run(input())
      .pipe(verifyEvents(), toArray()),
  );
  expect(events.at(-1)?.type).toBe(EventType.RUN_ERROR);
  expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(
    false,
  );
});

it('starts a fresh session when the Dot policy changes', async () => {
  const configuration = config();
  const make = (policy: string) =>
    new AcpAgent(
      configuration,
      {
        key: 'policy-thread',
        policy,
        prompt: 'Probe.',
        maxSteps: 3,
        check: () => {},
        tools: [
          {
            name: 'opendots_probe',
            description: 'Probe',
            parameters: z.object({}),
            execute: async () => ({ code: 'fixture' }),
          },
        ],
      },
      'probe',
    );
  const first = await lastValueFrom(make('old').run(input()).pipe(toArray()));
  const second = await lastValueFrom(
    make('revoked').run(input()).pipe(toArray()),
  );
  expect(text(second)).toContain('turn:1');
  expect(text(second).match(/process:(\d+)/)?.[1]).not.toBe(
    text(first).match(/process:(\d+)/)?.[1],
  );
});

it('limits live provider processes and releases hanging sessions on cancellation', async () => {
  const configuration = config(['--hang']);
  const running: AcpAgent[] = [];
  const completed: Promise<void>[] = [];
  try {
    for (const key of ['first', 'second']) {
      const agent = probe(configuration, key);
      running.push(agent);
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      completed.push(
        new Promise<void>((resolve, reject) => {
          agent.run(input(key)).subscribe({
            next: (event) => {
              if (event.type === EventType.RUN_STARTED) started();
            },
            complete: resolve,
            error: reject,
          });
        }),
      );
      await ready;
    }
    const extra = await lastValueFrom(
      probe(configuration, 'third').run(input('third')).pipe(toArray()),
    );
    expect(extra).toHaveLength(1);
    expect(extra[0].type).toBe(EventType.RUN_ERROR);
  } finally {
    for (const agent of running) agent.abortRun();
    await Promise.all(completed);
  }
}, 15_000);

it('preserves oversized saved history rather than silently truncating it on restore', async () => {
  const events = await lastValueFrom(
    probe(config())
      .run(
        input('thread', [
          {
            id: 'large',
            role: 'user',
            content: 'x'.repeat(100_000),
          },
        ]),
      )
      .pipe(verifyEvents(), toArray()),
  );
  expect(events.at(-1)).toMatchObject({
    type: EventType.RUN_ERROR,
    message: expect.stringContaining('saved history is retained'),
  });
});

it('pauses for the existing human review UI and resumes only with its tool result', async () => {
  const configuration = config(['--review']);
  const agent = new AcpAgent(
    configuration,
    {
      key: 'review',
      prompt: 'Review first.',
      check: () => {},
      maxSteps: 3,
      tools: [
        {
          name: 'review_space_page',
          description: 'Review',
          parameters: pageReviewSchema,
        },
      ],
    },
    'review-dot',
  );
  const events = await lastValueFrom(
    agent.run(input()).pipe(verifyEvents(), toArray()),
  );
  const call = events.find((event) => event.type === EventType.TOOL_CALL_START);
  expect(call?.toolCallName).toBe('review_space_page');
  expect(
    events.some((event) => event.type === EventType.TOOL_CALL_RESULT),
  ).toBe(false);
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  const result = await lastValueFrom(
    agent
      .run(
        input('thread', [
          {
            id: 'review-result',
            role: 'tool',
            toolCallId: z.string().parse(call?.toolCallId),
            content: '{"approved":false}',
          },
        ]),
      )
      .pipe(verifyEvents(), toArray()),
  );
  expect(text(result)).toContain('Review result received');
});

it('loads empty and saved conversations through the real AG-UI client after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opendots-local-test-'));
  const file = join(directory, 'workspace.sqlite');
  let store = new Store(file);
  let workspace = new WorkspaceStore(file, 'fixture-owner');
  const configuration = config();
  let platform = new Platform(store, workspace, configuration);
  try {
    const dot = workspace.dots()[0];
    const thread = await platform.createConversation(dot.id, 'Local chat');
    const replay = () =>
      new HttpAgent({
        threadId: thread.id,
        url: `http://local/api/copilotkit/agent/${dot.id}/connect`,
        fetch: (url, init) => platform.handle(new Request(url, init)),
      });
    const empty = replay();
    await empty.runAgent();
    expect(empty.messages).toEqual([]);
    const chat = new HttpAgent({
      threadId: thread.id,
      url: `http://local/api/copilotkit/agent/${dot.id}/run`,
      fetch: (url, init) => platform.handle(new Request(url, init)),
    });
    chat.addMessage({
      id: 'user',
      role: 'user',
      content: 'List the Spaces I can use.',
    });
    await chat.runAgent();
    expect(chat.messages.some((message) => message.role === 'tool')).toBe(true);
    await platform.stop();
    store.close();
    workspace.close();
    store = new Store(file);
    workspace = new WorkspaceStore(file, 'fixture-owner');
    platform = new Platform(store, workspace, configuration);
    const restored = replay();
    await restored.runAgent();
    expect(restored.messages).toEqual(chat.messages);
    expect(
      (await platform.pages.saveConversation(thread.id, 'Saved chat', null))
        .content,
    ).toContain('List the Spaces');
    const denied = await platform.handle(
      new Request(`http://local/api/copilotkit/agent/${dot.id}/connect`, {
        method: 'POST',
        body: JSON.stringify(input('foreign-thread')),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(denied.status).toBe(403);
  } finally {
    await platform.stop();
    store.close();
    workspace.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
