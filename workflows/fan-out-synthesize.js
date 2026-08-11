export const meta = {
  name: 'fan-out-synthesize',
  description: 'Partition → bounded artifact fan-out → evidence synthesis barrier (port of Atomic fanOutAndSynthesize)',
  phases: [
    { title: 'Partition', detail: 'split the prompt into independent branches' },
    { title: 'Fan-out', detail: 'one agent per branch, bounded' },
    { title: 'Synthesize', detail: 'barrier: consolidate all branch artifacts' },
  ],
}

// args: { run_id, prompt, max_branches = 4, max_concurrency = 4 }
// Slash-command invocation delivers everything after the command name as a
// STRING, so accept a JSON string (optionally followed by prose) too.
function atomicArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw === 'string') {
    const s = raw.trim()
    try { return JSON.parse(s) } catch {}
    const a = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)) } catch {} }
  }
  throw new Error('atomic: pass a JSON object of arguments, e.g. ' +
    '/atomic:fan-out-synthesize {"run_id":"f-1","prompt":"..."}')
}
const A = atomicArgs(args)
if (!A.run_id) throw new Error('atomic: run_id required')
if (!/^[A-Za-z0-9._-]{1,64}$/.test(A.run_id))
  throw new Error('atomic: run_id must match [A-Za-z0-9._-], max 64 chars (no slashes, spaces, or quotes)')
if (!A.prompt) throw new Error('atomic: prompt required')
const MAX_BRANCHES = Math.min(Math.max(A.max_branches ?? 4, 1), 12)     // Atomic default 4
const MAX_CONCURRENCY = Math.min(Math.max(A.max_concurrency ?? 4, 1), 12) // Atomic default 4

phase('Partition')
const plan = await agent(
  `Partition this task into at most ${MAX_BRANCHES} INDEPENDENT branches that can run in
parallel without touching the same concern. Task: ${A.prompt}
Fewer branches is better if the task does not naturally split.`,
  { schema: { type: 'object', additionalProperties: false, required: ['branches'],
      properties: { branches: { type: 'array', minItems: 1, maxItems: MAX_BRANCHES,
        items: { type: 'object', additionalProperties: false,
          required: ['title', 'scope'],
          properties: { title: { type: 'string' }, scope: { type: 'string' } } } } } },
    label: 'partition' })
if (!plan) throw new Error('atomic fan-out: partition stage returned null')

phase('Fan-out')
// Bounded fan-out: run branches in batches of MAX_CONCURRENCY (Atomic bounds
// concurrency; CC's own cap is 16, so batching keeps us at the requested bound).
const thunks = plan.branches.map((b, i) => () =>
  agent(
    `Branch ${i} of atomic fan-out run "${A.run_id}": ${b.title}
Scope (stay strictly inside it): ${b.scope}
Overall task for context only: ${A.prompt}
Do the work, then write your branch artifact to EXACTLY this path and no other file:
.atomic-cc/runs/${A.run_id}/branch-${i}.md (findings, evidence, file:line references).
Do not write additional copies under different names — the synthesis stage reads branch-*.md
and duplicates would be double-counted.
Return a compact summary of what you produced.`,
    { agentType: 'atomic:worker', label: `branch:${i}:${b.title.slice(0, 30)}` }))
const branches = []
for (let i = 0; i < thunks.length; i += MAX_CONCURRENCY)
  branches.push(...(await parallel(thunks.slice(i, i + MAX_CONCURRENCY))).filter(Boolean))

// Barrier is correct here by design: synthesis needs ALL branch artifacts together.
phase('Synthesize')
const synthesis = await agent(
  `Synthesis barrier for atomic fan-out run "${A.run_id}".
Read ALL branch artifacts in .atomic-cc/runs/${A.run_id}/ (branch-*.md) and consolidate them
into a single evidence-led synthesis at .atomic-cc/runs/${A.run_id}/synthesis.md:
resolve contradictions explicitly, keep file:line evidence, flag anything a branch claimed
without evidence. Branch summaries:
${branches.map((s, i) => `--- branch ${i} ---\n${String(s).slice(0, 2000)}`).join('\n')}
Return the synthesis as your final text.`,
  { label: 'synthesize' })

return { branches_planned: plan.branches.length, branches_completed: branches.length,
         synthesis_path: `.atomic-cc/runs/${A.run_id}/synthesis.md`,
         result: synthesis }
