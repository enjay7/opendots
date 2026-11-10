import type { WebConfig } from './parallel.js';
import type { SetupStatus } from '../shared/types.js';

// `copilotkit project select` writes the CLI name and deletes the template name.
const INTELLIGENCE_API_KEY_ENV_NAMES = [
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_KEY',
] as const;
export const INTELLIGENCE_KEY_MISSING_LABEL = `${INTELLIGENCE_API_KEY_ENV_NAMES[1]} (or ${INTELLIGENCE_API_KEY_ENV_NAMES[0]})`;
export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 90_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function intelligenceApiKeyFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return firstNonEmptyEnvValue(env, INTELLIGENCE_API_KEY_ENV_NAMES);
}

export function intelligenceWsUrlFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return firstNonEmptyEnvValue(env, [
    'INTELLIGENCE_GATEWAY_WS_URL',
    'INTELLIGENCE_WS_URL',
  ]);
}

export function agentRunTimeoutMsFromEnv(
  env: Record<string, string | undefined>,
): number {
  const raw = env.AGENT_RUN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_AGENT_RUN_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS)
    throw new Error(
      `AGENT_RUN_TIMEOUT_MS must be an integer between 1 and ${MAX_TIMER_DELAY_MS}.`,
    );
  return value;
}

function firstNonEmptyEnvValue(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export interface PlatformConfig extends WebConfig {
  agentBackend?: 'model' | 'acp';
  threadStorage?: 'intelligence' | 'local';
  acpProvider?: 'codex' | 'claude' | 'kiro';
  acpModel?: string;
  acpCommand?: string;
  acpArgs?: string[];
  intelligenceKey?: string;
  intelligenceApiUrl?: string;
  intelligenceWsUrl?: string;
  model?: string;
  apiKey?: string;
  baseUrl: string;
  agentRunTimeoutMs?: number;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  composioApiKey?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  slackChannel?: string;
  slackTeam?: string;
  slackUsers: string[];
  slackDotId?: string;
  runtimeUrl: string;
  ownerToken?: string;
}
export function setupStatus(
  config: PlatformConfig,
  slack = 'not_configured',
  activationFailed = false,
): SetupStatus {
  const missing = [
    config.threadStorage !== 'local' &&
      !config.intelligenceKey &&
      INTELLIGENCE_KEY_MISSING_LABEL,
    config.agentBackend !== 'acp' && !config.apiKey && 'OPENAI_API_KEY',
    config.agentBackend !== 'acp' && !config.model && 'OPENAI_MODEL',
  ].filter((item): item is string => !!item);
  const declaredSlack = !!(
    config.slackChannel &&
    config.slackTeam &&
    config.slackUsers.length
  );
  slack = declaredSlack
    ? activationFailed && slack !== 'online'
      ? 'activation_failed'
      : slack
    : config.slackChannel || config.slackTeam || config.slackUsers.length
      ? 'setup_required'
      : 'not_configured';
  if (config.threadStorage === 'local' && declaredSlack)
    slack = 'requires_intelligence';
  return {
    intelligence: !!config.intelligenceKey,
    model: config.agentBackend === 'acp' || !!(config.apiKey && config.model),
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    composio: !!config.composioApiKey,
    slack,
    missing,
  };
}

export function localAgentConfigFromEnv(
  env: Record<string, string | undefined>,
): Pick<
  PlatformConfig,
  | 'agentBackend'
  | 'threadStorage'
  | 'acpProvider'
  | 'acpModel'
  | 'acpCommand'
  | 'acpArgs'
> {
  const agentBackend = env.AGENT_BACKEND?.trim() || 'model';
  const threadStorage = env.THREAD_STORAGE?.trim() || 'intelligence';
  const acpProvider = env.ACP_PROVIDER?.trim() || 'codex';
  if (agentBackend !== 'acp' && agentBackend !== 'model')
    throw new Error('AGENT_BACKEND must be model or acp.');
  if (threadStorage !== 'local' && threadStorage !== 'intelligence')
    throw new Error('THREAD_STORAGE must be local or intelligence.');
  if (!['codex', 'claude', 'kiro'].includes(acpProvider))
    throw new Error('ACP_PROVIDER must be codex, claude, or kiro.');
  const args: unknown = env.ACP_ARGS ? JSON.parse(env.ACP_ARGS) : undefined;
  if (
    args !== undefined &&
    (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string'))
  )
    throw new Error('ACP_ARGS must be a JSON string array.');
  return {
    agentBackend,
    threadStorage,
    acpProvider: acpProvider as 'codex' | 'claude' | 'kiro',
    acpModel: env.ACP_MODEL?.trim() || undefined,
    acpCommand: env.ACP_COMMAND?.trim() || undefined,
    acpArgs: args as string[] | undefined,
  };
}
