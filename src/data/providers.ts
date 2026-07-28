import anthropicLogo from 'simple-icons/icons/anthropic.svg';
import googleLogo from 'simple-icons/icons/google.svg';
import xLogo from 'simple-icons/icons/x.svg';
import deepSeekLogo from 'simple-icons/icons/deepseek.svg';
import mistralLogo from 'simple-icons/icons/mistralai.svg';
import openRouterLogo from 'simple-icons/icons/openrouter.svg';
import huggingFaceLogo from 'simple-icons/icons/huggingface.svg';
import nvidiaLogo from 'simple-icons/icons/nvidia.svg';
import alibabaLogo from 'simple-icons/icons/alibabacloud.svg';
import ollamaLogo from 'simple-icons/icons/ollama.svg';
import copilotLogo from 'simple-icons/icons/githubcopilot.svg';
import perplexityLogo from 'simple-icons/icons/perplexity.svg';
import qwenLogo from 'simple-icons/icons/qwen.svg';
import cloudflareLogo from 'simple-icons/icons/cloudflare.svg';
import vercelLogo from 'simple-icons/icons/vercel.svg';
import gitlabLogo from 'simple-icons/icons/gitlab.svg';
import openAiLogo from '../assets/providers/openai.svg';
import groqLogo from '../assets/providers/groq.svg';

export type ProviderAuthKind = 'oauth' | 'api-key' | 'both' | 'local';

export interface ProviderPresentation {
  auth: ProviderAuthKind;
  color: string;
  logo?: string;
  apiKeyUrl?: string;
  webSearch?: boolean;
}

const fallback: ProviderPresentation = { auth: 'api-key', color: '#556176' };

const providers: Record<string, ProviderPresentation> = {
  anthropic: { auth: 'both', color: '#D97757', logo: anthropicLogo, apiKeyUrl: 'https://console.anthropic.com/settings/keys', webSearch: true },
  openai: { auth: 'api-key', color: '#10A37F', logo: openAiLogo, apiKeyUrl: 'https://platform.openai.com/api-keys', webSearch: true },
  'openai-codex': { auth: 'oauth', color: '#10A37F', logo: openAiLogo, webSearch: true },
  google: { auth: 'api-key', color: '#4285F4', logo: googleLogo, apiKeyUrl: 'https://aistudio.google.com/app/apikey' },
  'google-gemini-cli': { auth: 'oauth', color: '#4285F4', logo: googleLogo },
  xai: { auth: 'api-key', color: '#111111', logo: xLogo, apiKeyUrl: 'https://console.x.ai/' },
  'xai-oauth': { auth: 'oauth', color: '#111111', logo: xLogo },
  groq: { auth: 'api-key', color: '#F55036', logo: groqLogo, apiKeyUrl: 'https://console.groq.com/keys' },
  deepseek: { auth: 'api-key', color: '#4D6BFE', logo: deepSeekLogo, apiKeyUrl: 'https://platform.deepseek.com/api_keys' },
  mistral: { auth: 'api-key', color: '#FA520F', logo: mistralLogo, apiKeyUrl: 'https://console.mistral.ai/api-keys' },
  openrouter: { auth: 'api-key', color: '#5B5EF7', logo: openRouterLogo, apiKeyUrl: 'https://openrouter.ai/settings/keys' },
  huggingface: { auth: 'api-key', color: '#FFD21E', logo: huggingFaceLogo, apiKeyUrl: 'https://huggingface.co/settings/tokens' },
  nvidia: { auth: 'api-key', color: '#76B900', logo: nvidiaLogo, apiKeyUrl: 'https://build.nvidia.com/' },
  'alibaba-coding-plan': { auth: 'api-key', color: '#FF6A00', logo: alibabaLogo, apiKeyUrl: 'https://modelstudio.console.alibabacloud.com/' },
  ollama: { auth: 'local', color: '#20252D', logo: ollamaLogo },
  'ollama-cloud': { auth: 'api-key', color: '#20252D', logo: ollamaLogo },
  'github-copilot': { auth: 'oauth', color: '#6E40C9', logo: copilotLogo },
  perplexity: { auth: 'oauth', color: '#20808D', logo: perplexityLogo, webSearch: true },
  'qwen-portal': { auth: 'both', color: '#615CED', logo: qwenLogo },
  'cloudflare-ai-gateway': { auth: 'api-key', color: '#F38020', logo: cloudflareLogo, apiKeyUrl: 'https://dash.cloudflare.com/' },
  'vercel-ai-gateway': { auth: 'api-key', color: '#111111', logo: vercelLogo, apiKeyUrl: 'https://vercel.com/account/tokens' },
  'gitlab-duo': { auth: 'api-key', color: '#FC6D26', logo: gitlabLogo, apiKeyUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens' },
  cerebras: { auth: 'api-key', color: '#F05A28', apiKeyUrl: 'https://cloud.cerebras.ai/platform' },
  fireworks: { auth: 'api-key', color: '#6C5CE7', apiKeyUrl: 'https://app.fireworks.ai/settings/users/api-keys' },
  together: { auth: 'api-key', color: '#0B6E4F', apiKeyUrl: 'https://api.together.ai/settings/api-keys' },
  zai: { auth: 'api-key', color: '#246BFD', apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list', webSearch: true },
  moonshot: { auth: 'api-key', color: '#18181B', apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys', webSearch: true },
  kimi: { auth: 'oauth', color: '#111827', webSearch: true },
  'kimi-code': { auth: 'oauth', color: '#111827', webSearch: true },
  'lm-studio': { auth: 'local', color: '#4A5568' },
  'llama.cpp': { auth: 'local', color: '#4A5568' },
  vllm: { auth: 'local', color: '#4A5568' },
};

export function providerPresentation(id: string): ProviderPresentation {
  return providers[id] ?? fallback;
}

export function providerInitials(name: string): string {
  return name.split(/[\s./_-]+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?';
}
