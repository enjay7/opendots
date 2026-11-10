import { IntelligenceAgent } from '@copilotkit/core';
import { HttpAgent } from '@ag-ui/client';
import type { Message } from '@ag-ui/core';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt.js';
import { scheduledTaskMessagePrefix } from '../shared/scheduled-message.js';

export function currentTurnText(messages: Message[], error?: Error): string {
  if (error) throw error;
  const content = messages
    .filter((message) => message.role === 'assistant')
    .at(-1)?.content;
  if (typeof content !== 'string' || !content.trim())
    throw new Error('The current compute turn returned no assistant response.');
  return content;
}

const runtimeInfoSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('intelligence'),
    intelligence: z.object({ wsUrl: z.url() }),
    agents: z.record(z.string(), z.unknown()),
  }),
  z.object({
    mode: z.literal('sse'),
    agents: z.record(z.string(), z.unknown()),
  }),
]);

export async function runThreadTurn(
  runtimeUrl: string,
  headers: Record<string, string>,
  dotId: string,
  threadId: string,
  prompt: string,
  signal: AbortSignal,
  metadata?: Record<string, unknown>,
): Promise<string> {
  signal.throwIfAborted();
  const response = await fetch(`${runtimeUrl}/info`, { headers, signal });
  if (!response.ok)
    throw new Error(`Intelligence runtime returned HTTP ${response.status}.`);
  const info = runtimeInfoSchema.parse(await response.json());
  if (!Object.hasOwn(info.agents, dotId))
    throw new Error('The selected Dot is unavailable in the runtime.');
  // Core's runtime discovery is browser-only. Use the SDK's Node-compatible
  // Intelligence agent for voice compute and scheduled server turns.
  const common = {
    runtimeUrl,
    agentId: dotId,
    headers,
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      }),
  };
  const agent =
    info.mode === 'intelligence'
      ? new IntelligenceAgent({ ...common, url: info.intelligence.wsUrl })
      : new HttpAgent({
          ...common,
          url: `${runtimeUrl}/agent/${encodeURIComponent(dotId)}/run`,
        });
  agent.threadId = threadId;
  if (info.mode !== 'intelligence') {
    const history = await fetch(
      `${runtimeUrl}/threads/${encodeURIComponent(threadId)}/messages`,
      { headers, signal },
    );
    if (!history.ok)
      throw new Error(`Local conversation returned HTTP ${history.status}.`);
    const body = z
      .object({ messages: z.array(z.unknown()) })
      .parse(await history.json());
    const { MessageSchema } = await import('@ag-ui/core');
    agent.messages = body.messages.map((message) => {
      // Threads REST flattens function calls for the frontend's thread library;
      // the AG-UI run API requires the canonical function-call message shape.
      const flat = z
        .object({
          role: z.literal('assistant'),
          toolCalls: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              args: z.unknown(),
            }),
          ),
        })
        .passthrough()
        .safeParse(message);
      return MessageSchema.parse(
        flat.success
          ? {
              ...flat.data,
              toolCalls: flat.data.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments:
                    typeof call.args === 'string'
                      ? call.args
                      : JSON.stringify(call.args ?? {}),
                },
              })),
            }
          : message,
      );
    });
    const results = new Set(
      agent.messages.flatMap((message) =>
        message.role === 'tool' ? [message.toolCallId] : [],
      ),
    );
    const pendingReview = agent.messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.toolCalls?.some(
          (call) =>
            ['review_space_page', 'request_connection_action'].includes(
              call.function.name,
            ) && !results.has(call.id),
        ),
    );
    if (pendingReview)
      throw new Error(
        'This conversation is waiting for owner review. Complete its approval card before scheduling more work.',
      );
  }
  let runError: Error | undefined;
  const subscription = agent.subscribe({
    onRunErrorEvent: ({ event }) => {
      runError = new Error(event.message);
    },
  });
  const stop = () => agent.abortRun();
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    const idPrefix =
      metadata?.opendotsSource === 'voice_receipt'
        ? voiceReceiptMessagePrefix
        : metadata?.opendotsSource === 'scheduled_task'
          ? scheduledTaskMessagePrefix
          : '';
    agent.addMessage({
      id: `${idPrefix}${randomUUID()}`,
      role: 'user',
      content: prompt,
      ...(metadata ? { metadata } : {}),
    });
    const result = await agent.runAgent();
    signal.throwIfAborted();
    return currentTurnText(result.newMessages, runError);
  } finally {
    signal.removeEventListener('abort', stop);
    subscription.unsubscribe();
    await agent.detachActiveRun();
  }
}
