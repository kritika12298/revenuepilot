import { z } from 'zod';

/**
 * A backend tool Claude may *propose* calling. The executor decides whether
 * it actually runs.
 *
 * - `input` is a Zod schema; it is both sent to Claude (as JSON Schema) and
 *   used to validate whatever Claude sends back.
 * - `access` describes the side effect: read | write | notify | delegate.
 * - `scope: 'lead'` means the input carries `lead_id`, which must be the lead
 *   this run was started for (and therefore in the caller's business).
 */
export function defineTool({ name, description, input, access, scope = 'lead', handler }) {
  if (!/^[a-z_]{3,64}$/.test(name)) throw new Error(`Invalid tool name ${name}`);
  return Object.freeze({ name, description, input, access, scope, handler, definition: toToolDefinition(name, description, input) });
}

/** Drops Zod's verbose UUID regex; `format: "uuid"` says the same to the model. */
function compact(node) {
  if (Array.isArray(node)) return node.map(compact);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'pattern' && node.format === 'uuid') continue;
    out[key] = compact(value);
  }
  return out;
}

/** Converts a Zod schema into an Anthropic tool definition. */
export function toToolDefinition(name, description, schema) {
  const { $schema, ...inputSchema } = z.toJSONSchema(schema, { io: 'input' });
  return { name, description, input_schema: compact(inputSchema) };
}

/** Thrown by handlers when a business rule forbids the action. */
export class ToolPolicyError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const leadIdField = z.uuid().describe('ID of the lead this run is about.');
