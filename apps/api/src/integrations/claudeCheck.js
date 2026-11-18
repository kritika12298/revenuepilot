import Anthropic from '@anthropic-ai/sdk';

/** Verifies Claude access with the free Models API (no tokens billed). */
export async function checkClaude(model) {
  const client = new Anthropic({ maxRetries: 1, timeout: 15_000 });
  const info = await client.models.retrieve(model);
  return { model: info.id, displayName: info.display_name };
}
