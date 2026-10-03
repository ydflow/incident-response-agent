/** Read the existing enabled Provider only; refuse paths that would lazily migrate personal config. */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { getEnabledProviders, getDefaultProviderId } from './runtime-config.js';
import type { IncidentModelConfig } from './incident-model-budget.js';
export function resolveConfiguredIncidentModel(): {
  config: IncidentModelConfig | null;
  reason: string;
} {
  const file = path.join(DATA_DIR, 'config', 'claude-provider.json');
  try {
    if (!fs.existsSync(file))
      return { config: null, reason: 'no_configured_model' };
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 262144)
      return { config: null, reason: 'configured_model_unreadable' };
    const raw = fs.readFileSync(file, 'utf8');
    if (JSON.parse(raw).version !== 5)
      return {
        config: null,
        reason: 'personal_config_migration_not_authorized',
      };
    const enabled = getEnabledProviders(),
      defaultId = getDefaultProviderId();
    const selected = enabled.find((p) => p.id === defaultId) ?? enabled[0];
    if (!selected) return { config: null, reason: 'no_enabled_model' };
    const key = selected.anthropicApiKey,
      token = selected.anthropicAuthToken;
    if (!key && !token)
      return { config: null, reason: 'model_credentials_unavailable' };
    if (!selected.anthropicModel)
      return { config: null, reason: 'configured_model_id_missing' };
    const base = selected.anthropicBaseUrl || 'https://api.anthropic.com';
    const url = new URL(base);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return { config: null, reason: 'unsupported_configured_model_transport' };
    // Reuse Pi's existing custom Anthropic Messages transport/model resolution.
    // A model-name prefix does not establish endpoint availability; bounded smoke does.
    if (fs.readFileSync(file, 'utf8') !== raw)
      return { config: null, reason: 'configured_model_changed' };
    return {
      config: {
        base_url: base,
        model: selected.anthropicModel,
        ...(key ? { api_key: key } : { auth_token: token }),
        mode: 'real_pi',
      },
      reason: 'configured_not_yet_verified',
    };
  } catch {
    return { config: null, reason: 'configured_model_unreadable' };
  }
}
