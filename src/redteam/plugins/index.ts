import invariant from 'tiny-invariant';
import { fetchWithCache } from '../../cache';
import { VERSION } from '../../constants';
import { getEnvBool } from '../../envars';
import logger from '../../logger';
import { REQUEST_TIMEOUT_MS } from '../../providers/shared';
import type { ApiProvider, PluginActionParams, PluginConfig, TestCase } from '../../types';
import { HARM_PLUGINS, PII_PLUGINS, getRemoteGenerationUrl } from '../constants';
import { neverGenerateRemote, shouldGenerateRemote } from '../util';
import { type RedteamPluginBase } from './base';
import { ContractPlugin } from './contracts';
import { CrossSessionLeakPlugin } from './crossSessionLeak';
import { DebugAccessPlugin } from './debugAccess';
import { ExcessiveAgencyPlugin } from './excessiveAgency';
import { HallucinationPlugin } from './hallucination';
import { getHarmfulTests } from './harmful';
import { ImitationPlugin } from './imitation';
import { IntentPlugin } from './intent';
import { OverreliancePlugin } from './overreliance';
import { getPiiLeakTestsForCategory } from './pii';
import { PolicyPlugin } from './policy';
import { PoliticsPlugin } from './politics';
import { PromptExtractionPlugin } from './promptExtraction';
import { RbacPlugin } from './rbac';
import { ShellInjectionPlugin } from './shellInjection';
import { SqlInjectionPlugin } from './sqlInjection';

export interface PluginFactory {
  key: string;
  validate?: (config: PluginConfig) => void;
  action: (params: PluginActionParams) => Promise<TestCase[]>;
}

type PluginClass<T extends PluginConfig> = new (
  provider: ApiProvider,
  purpose: string,
  injectVar: string,
  config: T,
) => RedteamPluginBase;

async function fetchRemoteTestCases(
  key: string,
  purpose: string,
  injectVar: string,
  n: number,
  config?: PluginConfig,
): Promise<TestCase[]> {
  invariant(
    !getEnvBool('PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION'),
    'fetchRemoteTestCases should never be called when remote generation is disabled',
  );

  const body = JSON.stringify({
    task: key,
    purpose,
    injectVar,
    n,
    config,
    version: VERSION,
  });
  try {
    const { data } = await fetchWithCache(
      getRemoteGenerationUrl(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body,
      },
      REQUEST_TIMEOUT_MS,
    );
    const ret = (data as { result: TestCase[] }).result;
    logger.debug(`Received remote generation for ${key}:\n${JSON.stringify(ret)}`);
    return ret;
  } catch (err) {
    logger.error(`Error generating test cases for ${key}: ${err}`);
    return [];
  }
}

function createPluginFactory<T extends PluginConfig>(
  PluginClass: PluginClass<T>,
  key: string,
  validate?: (config: T) => void,
): PluginFactory {
  return {
    key,
    validate: validate as ((config: PluginConfig) => void) | undefined,
    action: async ({ provider, purpose, injectVar, n, delayMs, config }) => {
      if (shouldGenerateRemote()) {
        return fetchRemoteTestCases(key, purpose, injectVar, n, config);
      }
      logger.debug(`Using local redteam generation for ${key}`);
      return new PluginClass(provider, purpose, injectVar, config as T).generateTests(n, delayMs);
    },
  };
}

const pluginFactories: PluginFactory[] = [
  createPluginFactory(ContractPlugin, 'contracts'),
  createPluginFactory(CrossSessionLeakPlugin, 'cross-session-leak'),
  createPluginFactory(ExcessiveAgencyPlugin, 'excessive-agency'),
  createPluginFactory(HallucinationPlugin, 'hallucination'),
  createPluginFactory(ImitationPlugin, 'imitation'),
  createPluginFactory(OverreliancePlugin, 'overreliance'),
  createPluginFactory(SqlInjectionPlugin, 'sql-injection'),
  createPluginFactory(ShellInjectionPlugin, 'shell-injection'),
  createPluginFactory(DebugAccessPlugin, 'debug-access'),
  createPluginFactory(RbacPlugin, 'rbac'),
  createPluginFactory(PoliticsPlugin, 'politics'),
  createPluginFactory<{ policy: string }>(PolicyPlugin, 'policy', (config) =>
    invariant(config.policy, 'Policy plugin requires `config.policy` to be set'),
  ),
  createPluginFactory<{ intent: string }>(IntentPlugin, 'intent', (config) =>
    invariant(config.intent, 'Intent plugin requires `config.intent` to be set'),
  ),
  createPluginFactory<{ systemPrompt: string }>(
    PromptExtractionPlugin,
    'prompt-extraction',
    (config) =>
      invariant(
        config.systemPrompt,
        'Prompt extraction plugin requires `config.systemPrompt` to be set',
      ),
  ),
];

const harmPlugins: PluginFactory[] = Object.keys(HARM_PLUGINS).map((category) => ({
  key: category,
  action: async (params) => {
    if (shouldGenerateRemote()) {
      return fetchRemoteTestCases(category, params.purpose, params.injectVar, params.n);
    }
    logger.debug(`Using local redteam generation for ${category}`);
    return getHarmfulTests(params, [category]);
  },
}));

const piiPlugins: PluginFactory[] = PII_PLUGINS.map((category) => ({
  key: category,
  action: async (params) => {
    if (shouldGenerateRemote()) {
      return fetchRemoteTestCases(category, params.purpose, params.injectVar, params.n);
    }
    logger.debug(`Using local redteam generation for ${category}`);
    return getPiiLeakTestsForCategory(params, category);
  },
}));

function createRemotePlugin<T extends PluginConfig>(
  key: string,
  validate?: (config: T) => void,
): PluginFactory {
  return {
    key,
    validate: validate as ((config: PluginConfig) => void) | undefined,
    action: async ({ provider, purpose, injectVar, n, delayMs, config }) => {
      if (neverGenerateRemote()) {
        throw new Error(`${key} plugin requires remote generation to be enabled`);
      }
      return fetchRemoteTestCases(key, purpose, injectVar, n, config);
    },
  };
}
const remotePlugins: PluginFactory[] = [
  'ascii-smuggling',
  'bfla',
  'bola',
  'competitors',
  'hijacking',
  'religion',
  'ssrf',
].map((key) => createRemotePlugin(key));
remotePlugins.push(
  createRemotePlugin<{ indirectInjectionVar: string }>('indirect-prompt-injection', (config) =>
    invariant(
      config.indirectInjectionVar,
      'Indirect prompt injection plugin requires `config.indirectInjectionVar` to be set',
    ),
  ),
);

export const Plugins: PluginFactory[] = [
  ...pluginFactories,
  ...harmPlugins,
  ...piiPlugins,
  ...remotePlugins,
];
