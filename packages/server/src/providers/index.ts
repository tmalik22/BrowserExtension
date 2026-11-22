import { resolveApiKey } from '../config.ts';
import { AnthropicProvider } from './anthropic.ts';
import { MockProvider } from './mock.ts';
import { OpenAICompatProvider } from './openai.ts';
import type { ModelProfile, Provider } from './types.ts';

export function createProvider(profile: ModelProfile): Provider {
  switch (profile.provider) {
    case 'anthropic': {
      const key = resolveApiKey(profile);
      if (!key) throw new Error(`Profile "${profile.id}" has no API key. Add it in Settings → API keys (or set ${profile.apiKeyEnv ?? 'ANTHROPIC_API_KEY'} in .env).`);
      return new AnthropicProvider(profile, key);
    }
    case 'openai': {
      const key = resolveApiKey(profile);
      if (!key && profile.apiKeyEnv) throw new Error(`Profile "${profile.id}" has no API key. Add it in Settings → API keys (or set ${profile.apiKeyEnv} in .env).`);
      return new OpenAICompatProvider(profile, key ?? '');
    }
    case 'mock':
      return new MockProvider(profile.script);
    default:
      throw new Error(`Unknown provider ${(profile as ModelProfile).provider}`);
  }
}

export type { Provider, ModelProfile } from './types.ts';
