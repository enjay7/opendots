import { randomUUID } from 'node:crypto';
import { EventType, type BaseEvent } from '@ag-ui/core';
import {
  AgentRunner,
  finalizeRunEvents,
  type AgentRunnerRunRequest,
  type AgentRunnerConnectRequest,
  type AgentRunnerStopRequest,
  type AgentRunnerIsRunningRequest,
} from '@copilotkit/runtime/v2';
import { Observable, ReplaySubject, filter } from 'rxjs';
import type { WorkspaceStore } from './workspace.js';

type ActiveRun = {
  request: AgentRunnerRunRequest;
  events: ReplaySubject<BaseEvent>;
  stopRequested: boolean;
  done: Promise<void>;
};

/** Workspace-owned durable snapshots; never uses the SDK's global in-memory store. */
export class LocalThreads extends AgentRunner {
  readonly ɵsupportsLocalThreadEndpoints = true;
  private active = new Map<string, ActiveRun>();
  constructor(private workspace: WorkspaceStore) {
    super();
  }
  run(request: AgentRunnerRunRequest) {
    this.workspace.requireThread(request.threadId, request.agent.agentId);
    if (this.active.has(request.threadId))
      throw new Error('Thread already running.');
    const active: ActiveRun = {
      request,
      events: new ReplaySubject<BaseEvent>(),
      stopRequested: false,
      done: Promise.resolve(),
    };
    this.active.set(request.threadId, active);
    active.done = this.execute(active);
    return active.events.asObservable();
  }
  connect(request: AgentRunnerConnectRequest) {
    return new Observable<BaseEvent>((subscriber) => {
      this.workspace.requireThread(request.threadId, request.agentId);
      const active = this.active.get(request.threadId);
      const runId = active?.request.input.runId ?? randomUUID();
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: request.threadId,
        runId,
      });
      const saved = this.workspace.localConversation(request.threadId);
      subscriber.next({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: active?.request.input.messages ?? saved.messages,
      });
      subscriber.next({
        type: EventType.STATE_SNAPSHOT,
        snapshot: active?.request.input.state ?? saved.state,
      });
      if (active) {
        const subscription = active.events
          .pipe(filter((event) => event.type !== EventType.RUN_STARTED))
          .subscribe(subscriber);
        return () => subscription.unsubscribe();
      }
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: request.threadId,
        runId,
      });
      subscriber.complete();
    });
  }
  async isRunning(request: AgentRunnerIsRunningRequest) {
    return this.active.has(request.threadId);
  }
  async stop(request: AgentRunnerStopRequest) {
    const active = this.active.get(request.threadId);
    if (
      !active ||
      active.stopRequested ||
      (request.runId && active.request.input.runId !== request.runId)
    )
      return false;
    active.stopRequested = true;
    active.request.agent.abortRun();
    return true;
  }
  async shutdown() {
    const runs = [...this.active.values()];
    for (const run of runs) {
      run.stopRequested = true;
      run.request.agent.abortRun();
    }
    await Promise.all(runs.map((run) => run.done));
  }
  private async execute(active: ActiveRun) {
    const { request } = active;
    const events: BaseEvent[] = [];
    try {
      this.workspace.saveLocalConversation(
        request.threadId,
        request.input.messages,
        request.input.state,
      );
      if (!active.stopRequested)
        await request.agent.runAgent(request.input, {
          onEvent: ({ event }) => {
            events.push(event);
            if (event.type !== EventType.RUN_FINISHED)
              active.events.next(event);
          },
        });
    } catch (error) {
      for (const event of finalizeRunEvents(events, {
        stopRequested: active.stopRequested,
        interruptionMessage:
          error instanceof Error ? error.message : 'Conversation failed.',
      })) {
        events.push(event);
        if (event.type !== EventType.RUN_FINISHED) active.events.next(event);
      }
    } finally {
      try {
        this.workspace.saveLocalConversation(
          request.threadId,
          request.agent.messages.length
            ? request.agent.messages
            : request.input.messages,
          request.agent.state,
        );
        const terminal = events.findLast(
          (event) =>
            event.type === EventType.RUN_FINISHED ||
            event.type === EventType.RUN_ERROR,
        );
        if (terminal?.type === EventType.RUN_FINISHED)
          active.events.next(terminal);
        else if (terminal?.type !== EventType.RUN_ERROR)
          active.events.next({
            type: EventType.RUN_FINISHED,
            threadId: request.threadId,
            runId: request.input.runId,
          });
        active.events.complete();
      } catch (error) {
        active.events.error(error);
      }
      this.active.delete(request.threadId);
    }
  }
  listThreads() {
    return this.workspace.conversations().map((thread) => ({
      id: thread.id,
      name: thread.title,
      agentId: thread.dotId,
      organizationId: 'local',
      createdById: this.workspace.ownerId,
      archived: false,
      createdAt: new Date(thread.createdAt).toISOString(),
      updatedAt: this.workspace.localConversation(thread.id).updatedAt,
    }));
  }
  getThreadMessages(threadId: string) {
    return this.workspace.localConversation(threadId).messages;
  }
  getThreadState(threadId: string) {
    return this.workspace.localConversation(threadId).state;
  }
  getThreadEvents(threadId: string): BaseEvent[] {
    const runId = randomUUID();
    const snapshot = this.workspace.localConversation(threadId);
    return [
      { type: EventType.RUN_STARTED, threadId, runId },
      { type: EventType.MESSAGES_SNAPSHOT, messages: snapshot.messages },
      { type: EventType.STATE_SNAPSHOT, snapshot: snapshot.state },
      { type: EventType.RUN_FINISHED, threadId, runId },
    ];
  }
  clearThreads(): void {
    throw new Error('Deleting all saved conversations is disabled.');
  }
  async createThread(input: {
    threadId: string;
    userId: string;
    agentId: string;
    name: string;
  }) {
    if (
      input.userId !== this.workspace.ownerId ||
      !this.workspace.dot(input.agentId)
    )
      throw new Error('Conversation scope denied.');
    return { id: input.threadId };
  }
  async getOrCreateThread(input: {
    threadId: string;
    userId: string;
    agentId: string;
    name: string;
  }) {
    return this.createThread(input);
  }
  async getThreadMessagesForOwner(input: { threadId: string; userId: string }) {
    if (input.userId !== this.workspace.ownerId)
      throw new Error('Conversation scope denied.');
    return { messages: this.getThreadMessages(input.threadId) };
  }
}
