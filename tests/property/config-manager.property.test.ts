import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { ConfigManager } from '../../src/config/config-manager.js';
import type { AppConfig } from '../../src/types/config.js';

// Feature: nodejs-claude-code, Property 30: 配置优先级链
// For any combination of global config, project config, and env vars,
// the merged config should respect priority: env vars > project config > global config > defaults

// Arbitrary for partial LLM config
const partialLlmConfigArb = fc.record(
  {
    apiKey: fc.string({ minLength: 1, maxLength: 50 }),
    baseUrl: fc.string({ minLength: 1, maxLength: 100 }),
    model: fc.string({ minLength: 1, maxLength: 50 }),
    maxTokens: fc.integer({ min: 100, max: 100000 }),
    temperature: fc.float({ min: 0, max: 2, noNaN: true }),
  },
  { requiredKeys: [] }
);

// Arbitrary for partial AppConfig
const partialAppConfigArb = fc.record(
  {
    llm: partialLlmConfigArb,
  },
  { requiredKeys: [] }
) as fc.Arbitrary<Partial<AppConfig>>;

describe('Property 30: 配置优先级链', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Save original env vars
    originalEnv = {
      AI_ASSISTANT_API_KEY: process.env['AI_ASSISTANT_API_KEY'],
      ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
      AI_ASSISTANT_BASE_URL: process.env['AI_ASSISTANT_BASE_URL'],
      ANTHROPIC_BASE_URL: process.env['ANTHROPIC_BASE_URL'],
      AI_ASSISTANT_MODEL: process.env['AI_ASSISTANT_MODEL'],
      AI_ASSISTANT_MAX_TOKENS: process.env['AI_ASSISTANT_MAX_TOKENS'],
      AI_ASSISTANT_TEMPERATURE: process.env['AI_ASSISTANT_TEMPERATURE'],
    };
    // Clear env vars before each test
    delete process.env['AI_ASSISTANT_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['AI_ASSISTANT_BASE_URL'];
    delete process.env['ANTHROPIC_BASE_URL'];
    delete process.env['AI_ASSISTANT_MODEL'];
    delete process.env['AI_ASSISTANT_MAX_TOKENS'];
    delete process.env['AI_ASSISTANT_TEMPERATURE'];
  });

  afterEach(() => {
    // Restore original env vars
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // Property 1: For any two partial configs A and B,
  // mergeConfigs(defaults, A, B) should have B's values where B defines them,
  // A's values where only A defines them, and defaults where neither defines them
  it('mergeConfigs respects later config override for scalar values', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (defaultApiKey, configAApiKey, configBApiKey) => {
          const defaults: Partial<AppConfig> = { llm: { apiKey: defaultApiKey, baseUrl: '', model: '', maxTokens: 1000, temperature: 0.7 } };
          const configA: Partial<AppConfig> = { llm: { apiKey: configAApiKey, baseUrl: '', model: '', maxTokens: 1000, temperature: 0.7 } };
          const configB: Partial<AppConfig> = { llm: { apiKey: configBApiKey, baseUrl: '', model: '', maxTokens: 1000, temperature: 0.7 } };

          const merged = ConfigManager.mergeConfigs(defaults, configA, configB);

          // B's value should win
          expect(merged.llm.apiKey).toBe(configBApiKey);
        }
      ),
      { numRuns: 25 }
    );
  });

  it('mergeConfigs uses A value when B does not define the key', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (configAModel, defaultModel) => {
          const defaults: Partial<AppConfig> = { llm: { apiKey: '', baseUrl: '', model: defaultModel, maxTokens: 1000, temperature: 0.7 } };
          const configA: Partial<AppConfig> = { llm: { apiKey: '', baseUrl: '', model: configAModel, maxTokens: 1000, temperature: 0.7 } };
          // configB does not define llm.model
          const configB: Partial<AppConfig> = {};

          const merged = ConfigManager.mergeConfigs(defaults, configA, configB);

          // A's value should win since B doesn't define it
          expect(merged.llm.model).toBe(configAModel);
        }
      ),
      { numRuns: 25 }
    );
  });

  it('mergeConfigs uses defaults when neither A nor B define the key', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        (defaultModel) => {
          const defaults: Partial<AppConfig> = { llm: { apiKey: '', baseUrl: '', model: defaultModel, maxTokens: 1000, temperature: 0.7 } };
          const configA: Partial<AppConfig> = {};
          const configB: Partial<AppConfig> = {};

          const merged = ConfigManager.mergeConfigs(defaults, configA, configB);

          // Default value should be used
          expect(merged.llm.model).toBe(defaultModel);
        }
      ),
      { numRuns: 25 }
    );
  });

  // Property 2: mergeConfigs is idempotent - mergeConfigs(config, config) === config
  it('mergeConfigs is idempotent: mergeConfigs(config, config) equals config', () => {
    fc.assert(
      fc.property(
        partialAppConfigArb,
        (partialConfig) => {
          const merged = ConfigManager.mergeConfigs(partialConfig, partialConfig);

          // The result should equal merging once
          const mergedOnce = ConfigManager.mergeConfigs(partialConfig);

          // Check llm fields if present
          if (partialConfig.llm) {
            if (partialConfig.llm.apiKey !== undefined) {
              expect(merged.llm.apiKey).toBe(mergedOnce.llm.apiKey);
            }
            if (partialConfig.llm.model !== undefined) {
              expect(merged.llm.model).toBe(mergedOnce.llm.model);
            }
            if (partialConfig.llm.maxTokens !== undefined) {
              expect(merged.llm.maxTokens).toBe(mergedOnce.llm.maxTokens);
            }
          }
        }
      ),
      { numRuns: 25 }
    );
  });

  // Property 3: env var AI_ASSISTANT_API_KEY overrides any project/global config apiKey value
  it('env var AI_ASSISTANT_API_KEY overrides project and global config apiKey', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('\0')),
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('\0')),
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('\0')),
        (envApiKey, projectApiKey, globalApiKey) => {
          // Set env var
          process.env['AI_ASSISTANT_API_KEY'] = envApiKey;

          const projectConfig: Partial<AppConfig> = {
            llm: { apiKey: projectApiKey, baseUrl: '', model: 'test', maxTokens: 1000, temperature: 0.7 }
          };
          const globalConfig: Partial<AppConfig> = {
            llm: { apiKey: globalApiKey, baseUrl: '', model: 'test', maxTokens: 1000, temperature: 0.7 }
          };

          // Simulate the merge order: defaults < global < project < env
          const envConfig: Partial<AppConfig> = {
            llm: { apiKey: envApiKey, baseUrl: '', model: 'test', maxTokens: 1000, temperature: 0.7 }
          };

          const merged = ConfigManager.mergeConfigs(globalConfig, projectConfig, envConfig);

          // Env var value should win
          expect(merged.llm.apiKey).toBe(envApiKey);

          // Cleanup
          delete process.env['AI_ASSISTANT_API_KEY'];
        }
      ),
      { numRuns: 25 }
    );
  });

  // Additional: verify the full load() priority chain with env var override
  it('load() respects env var AI_ASSISTANT_API_KEY over any file-based config', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('\0') && !s.includes('=')),
        (envApiKey) => {
          process.env['AI_ASSISTANT_API_KEY'] = envApiKey;

          // Use a temp dir that has no .ai-assistant.json
          const config = ConfigManager.load('/tmp');

          expect(config.llm.apiKey).toBe(envApiKey);

          delete process.env['AI_ASSISTANT_API_KEY'];
        }
      ),
      { numRuns: 25 }
    );
  });

  // Validates: Requirements 7.3, 7.4
  it('priority chain: env vars > project config > global config (Property 30)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }).filter(s => !s.includes('\0')),
        fc.string({ minLength: 1, maxLength: 40 }).filter(s => !s.includes('\0')),
        fc.string({ minLength: 1, maxLength: 40 }).filter(s => !s.includes('\0')),
        (envModel, projectModel, globalModel) => {
          // Simulate priority chain via mergeConfigs
          // Order: defaults < global < project < env
          const globalConfig: Partial<AppConfig> = {
            llm: { apiKey: '', baseUrl: '', model: globalModel, maxTokens: 1000, temperature: 0.7 }
          };
          const projectConfig: Partial<AppConfig> = {
            llm: { apiKey: '', baseUrl: '', model: projectModel, maxTokens: 1000, temperature: 0.7 }
          };
          const envConfig: Partial<AppConfig> = {
            llm: { apiKey: '', baseUrl: '', model: envModel, maxTokens: 1000, temperature: 0.7 }
          };

          // env > project > global
          const merged = ConfigManager.mergeConfigs(globalConfig, projectConfig, envConfig);
          expect(merged.llm.model).toBe(envModel);

          // project > global (no env)
          const mergedNoEnv = ConfigManager.mergeConfigs(globalConfig, projectConfig);
          expect(mergedNoEnv.llm.model).toBe(projectModel);

          // global only
          const mergedGlobalOnly = ConfigManager.mergeConfigs(globalConfig);
          expect(mergedGlobalOnly.llm.model).toBe(globalModel);
        }
      ),
      { numRuns: 25 }
    );
  });
});
