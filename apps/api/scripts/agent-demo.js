/**
 * Runs an agent against a seeded lead and prints the audit trail.
 *
 *   npm run agent:demo                          # orchestrator on "Priya Shah"
 *   npm run agent:demo -- "Sofia Alvarez" lead_intelligence
 *
 * Uses AI_MODE from .env; set AI_MODE=live to call Claude (billed).
 */
import { prisma } from '../src/lib/prisma.js';
import { env } from '../src/config/env.js';
import * as agents from '../src/modules/agents/agent.service.js';

const [leadName = 'Priya Shah', agent = 'orchestrator'] = process.argv.slice(2);

const lead = await prisma.lead.findFirst({ where: { name: leadName }, orderBy: { createdAt: 'desc' } });
if (!lead) {
  console.error(`No lead named "${leadName}". Run npm run db:seed first.`);
  process.exit(1);
}
const owner = await prisma.membership.findFirst({ where: { businessId: lead.businessId, role: 'OWNER' } });

console.log(`AI mode: ${env.AI_MODE_RESOLVED}${env.AI_MODE_RESOLVED === 'live' ? ` (${env.ANTHROPIC_MODEL}, effort ${env.AI_EFFORT ?? 'default'})` : ''}`);
console.log(`Running ${agent} on ${lead.name} (${lead.status})...\n`);

const print = (run, indent = '') => {
  console.log(`${indent}${run.kind} ${run.status}${run.errorCode ? ` ${run.errorCode}` : ''} · ${run.iterations} calls · ${run.inputTokens ?? 0} in / ${run.outputTokens ?? 0} out tokens · ${run.latencyMs} ms`);
  for (const c of run.toolCalls ?? []) {
    console.log(`${indent}  ${c.outcome === 'EXECUTED' ? '✓' : '✗'} ${c.toolName} ${c.outcome}${c.error ? ` - ${c.error}` : ''}`);
  }
};

try {
  const run = await agents.start({ businessId: lead.businessId, userId: owner.userId }, lead.id, { agent });
  print(run);
  for (const child of run.childRuns ?? []) print(child, '    ');
  console.log('\nOutput:', JSON.stringify(run.output, null, 2));
  const updated = await prisma.lead.findUnique({ where: { id: lead.id } });
  console.log(`\nLead now: ${updated.status}, score ${updated.score}`);
  if (updated.scoreBreakdown?.reasons) console.log('Reasons:', updated.scoreBreakdown.reasons);
  const draft = run.output?.draftMessageId && (await prisma.message.findUnique({ where: { id: run.output.draftMessageId } }));
  if (draft) console.log(`\nDraft (${draft.status}):\n${draft.body}`);
} catch (err) {
  console.error(`Failed: ${err.code ?? ''} ${err.message}`, err.details ?? '');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
