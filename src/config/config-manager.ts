import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AppConfig } from '../types/config.js';

const DEFAULT_CONFIG: AppConfig = {
  llm: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'claude-3-5-sonnet-20241022',
    maxTokens: 8192,
    temperature: 0.7,
  },
  context: {
    maxChunkSize: 60,
    overlapLines: 2,
    toolOutputMaxLines: 200,
  },
  conversation: {
    highWaterMark: 0.8,
    lowWaterMark: 0.5,
    maxContextTokens: 200000,
  },
  retriever: {
    vectorWeight: 0.7,
    bm25Weight: 0.3,
    similarityThreshold: 0.5,
    topK: 10,
    expandAdjacentChunks: true,
    expandDependencyChunks: true,
  },
  security: {
    sensitiveFilePatterns: ['.env', '*.pem', '*.key', '*.p12', '*.pfx'],
    confirmShellCommands: true,
  },
  httpApi: {
    port: 3000,
    host: '127.0.0.1',
    bearerToken: '',
    corsAllowedOrigins: [],
  },
  session: {
    storagePath: '.ai-assistant/sessions/',
    expirationDays: 30,
  },
  idempotency: {
    ttlMs: 86400000,
  },
};

export class ConfigManager {
  /**
   * Load config with priority: env vars > project config > global config > defaults
   */
  static load(workDir: string): AppConfig {
    const defaults = DEFAULT_CONFIG;
    const globalConfig = ConfigManager.loadGlobalConfig();
    const projectConfig = ConfigManager.loadProjectConfig(workDir);
    const envConfig = ConfigManager.loadEnvConfig();

    return ConfigManager.mergeConfigs(defaults, globalConfig, projectConfig, envConfig);
  }

  /**
   * Read project-level config from .ai-assistant.json in workDir
   */
  static loadProjectConfig(workDir: string): Partial<AppConfig> {
    const configPath = path.join(workDir, '.ai-assistant.json');
    return ConfigManager.readJsonFile(configPath);
  }

  /**
   * Read global config from ~/.ai-assistant/config.json
   */
  static loadGlobalConfig(): Partial<AppConfig> {
    const configPath = path.join(os.homedir(), '.ai-assistant', 'config.json');
    return ConfigManager.readJsonFile(configPath);
  }

  /**
   * Deep merge configs; later configs override earlier ones
   */
  static mergeConfigs(...configs: Partial<AppConfig>[]): AppConfig {
    let result: AppConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    for (const config of configs) {
      result = deepMerge(
        result as unknown as Record<string, unknown>,
        config as unknown as Record<string, unknown>,
      ) as unknown as AppConfig;
    }
    return result;
  }

  private static loadEnvConfig(): Partial<AppConfig> {
    const env = process.env;
    const config: Partial<AppConfig> = {};

    const apiKey = env['AI_ASSISTANT_API_KEY'] ?? env['ANTHROPIC_API_KEY'];
    const baseUrl = env['AI_ASSISTANT_BASE_URL'] ?? env['ANTHROPIC_BASE_URL'];
    const model = env['AI_ASSISTANT_MODEL'];
    const maxTokens = env['AI_ASSISTANT_MAX_TOKENS'];
    const temperature = env['AI_ASSISTANT_TEMPERATURE'];
    const bearerToken = env['AI_ASSISTANT_BEARER_TOKEN'];
    const port = env['AI_ASSISTANT_PORT'];

    const hasLlmOverride = apiKey !== undefined || baseUrl !== undefined || model !== undefined ||
      maxTokens !== undefined || temperature !== undefined;

    if (hasLlmOverride) {
      config.llm = {} as AppConfig['llm'];
      if (apiKey !== undefined) config.llm.apiKey = apiKey;
      if (baseUrl !== undefined) config.llm.baseUrl = baseUrl;
      if (model !== undefined) config.llm.model = model;
      if (maxTokens !== undefined) config.llm.maxTokens = parseInt(maxTokens, 10);
      if (temperature !== undefined) config.llm.temperature = parseFloat(temperature);
    }

    const hasHttpApiOverride = bearerToken !== undefined || port !== undefined;
    if (hasHttpApiOverride) {
      config.httpApi = {} as AppConfig['httpApi'];
      if (bearerToken !== undefined) config.httpApi.bearerToken = bearerToken;
      if (port !== undefined) config.httpApi.port = parseInt(port, 10);
    }

    return config;
  }

  private static readJsonFile(filePath: string): Partial<AppConfig> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as Partial<AppConfig>;
    } catch {
      return {};
    }
  }
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      );
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}
