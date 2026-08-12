// Run-lifecycle tests for the four artifact-only workflows.
//
// Their stages are told to write nothing but their own report, but they drive
// atomic:worker and the default subagent, both of which hold Edit/Write/Bash —
// so that instruction is a prompt, not a permission, and the run must register
// with the commit gate anyway. These tests execute the real workflow scripts and
// assert the gate commands actually reach an agent, on every exit path, with
// approved=false. Grepping the source would not prove the code path runs.
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runWorkflow, check, eq, group, report } from './harness.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WF = n => join(ROOT, 'workflows', `${n}.js`)
const PLUGIN_ROOT = '/plugins/atomic cc'   // a space, because the real path has one

// Gate commands travel inside a scribe prompt. These helpers read them back out
// the way the shell eventually will.
const gateCalls = calls => calls.filter(c => c.prompt.includes('bin/run-state.sh'))
const gateCmds = calls => gateCalls(calls)
  .flatMap(c => c.prompt.split('\n').filter(l => l.includes('bin/run-state.sh')).map(l => l.trim()))
const begins = calls => gateCmds(calls).filter(c => / begin /.test(c))
const seals = calls => gateCmds(calls).filter(c => / seal /.test(c))

// A mock that answers by schema shape, so one function drives every workflow.
function mockAgent(overrides = {}) {
  return async (call, index) => {
    if (overrides.onCall) {
      const forced = overrides.onCall(call, index)
      if (forced !== undefined) return forced
    }
    const s = call.opts?.schema
    if (!s) return `result for ${call.label ?? index}`
    const req = s.required ?? []
    if (req.includes('winner') && req.includes('rationale')) return { winner: 'first', rationale: 'clearer evidence', evidence: ['read both artifacts'] }
    if (req.includes('shortlist') && req.includes('discarded')) return { shortlist: overrides.shortlist ?? [], discarded: [] }
    if (req.includes('shortlist') && req.includes('rationale')) return { shortlist: overrides.shortlist ?? [], rationale: 'ranked by rubric' }
    if (req.includes('partitions')) return { partitions: [{ label: 'alpha', objective: 'investigate alpha' }, { label: 'beta', objective: 'investigate beta' }] }
    if (req.includes('audience')) return { audience: 'developers', goals: ['ship'], constraints: [], style_direction: 'plain', sections: ['hero'], gaps_and_assumptions: [] }
    if (req.includes('approved') && req.includes('findings')) return { approved: true, findings: [], rationale: 'satisfies the brief' }
    if (req.includes('category')) return { category: 'analysis', confidence: 0.95, rationale: 'clearly analysis' }
    if (req.includes('done')) return { done: true, summary: 'the objective is met', new_findings: [], failures: [], validation_evidence: ['ran the suite: 0 failures'], remaining_work: '' }
    throw new Error(`mock has no answer for schema requiring ${JSON.stringify(req)}`)
  }
}

const CASES = [
  { name: 'tournament', args: { run_id: 'tour-1', prompt: 'design a cache', num_attempts: 3 } },
  { name: 'generate-and-filter', args: { run_id: 'gf-1', prompt: 'name the product', num_candidates: 3, shortlist_size: 2 } },
  { name: 'fan-out-synthesize', args: { run_id: 'fan-1', prompt: 'map the auth flow', max_branches: 2 } },
  { name: 'open-claude-design', args: { run_id: 'ocd-1', prompt: 'a landing page', discover_references: false, max_refinements: 1 } },
]

for (const c of CASES) {
  group(`${c.name}: registers and seals the run`)
  const { calls, value } = await runWorkflow(WF(c.name), {
    args: { ...c.args, plugin_root: PLUGIN_ROOT }, agent: mockAgent(),
  })
  eq('exactly one begin', begins(calls).length, 1)
  check('begin names this run', begins(calls)[0]?.includes(`begin ${c.args.run_id}`), begins(calls)[0])
  eq('exactly one seal', seals(calls).length, 1)
  check('seal is terminal and unapproved',
    seals(calls)[0]?.includes(`seal ${c.args.run_id} complete false`), seals(calls)[0])
  check('the quoted plugin root survives the space in the path',
    gateCmds(calls).every(cmd => cmd.startsWith(`"${PLUGIN_ROOT}/bin/run-state.sh"`)), gateCmds(calls)[0])
  check('the gate is handed to the scribe, never to a write-capable agent',
    gateCalls(calls).every(x => x.agentType === 'atomic:scribe'),
    gateCalls(calls).map(x => x.agentType).join(','))
  check('no seal is ever approved=true', !gateCmds(calls).some(cmd => / seal \S+ \S+ true/.test(cmd)))
  // begin must precede every stage that can write.
  const firstGate = calls.findIndex(x => x.prompt.includes('bin/run-state.sh'))
  const firstWriter = calls.findIndex(x => x.agentType !== 'atomic:scribe')
  check('begin runs before the first write-capable stage', firstGate >= 0 && firstGate < firstWriter,
    `gate at ${firstGate}, first writer at ${firstWriter}`)
  check('the run still returns a result', value != null)

  group(`${c.name}: without plugin_root it forges no state`)
  const bare = await runWorkflow(WF(c.name), { args: c.args, agent: mockAgent() })
  eq('no gate command is issued', gateCmds(bare.calls).length, 0)
  check('and no agent is told to write the state file itself',
    !bare.calls.some(x => /Write[^\n]*run-state\.json/i.test(x.prompt)))
  check('the skip is logged rather than silent',
    bare.logs.some(m => /gate registration skipped/.test(m)), bare.logs.join(' | '))
}

group('tournament: the failure path seals too')
// Two dead attempts leave fewer than two entrants, so the bracket cannot run.
const dead = await runWorkflow(WF('tournament'), {
  args: { run_id: 'tour-dead', prompt: 'design a cache', num_attempts: 3, plugin_root: PLUGIN_ROOT },
  agent: mockAgent({ onCall: call => (/^attempt:[12]$/.test(call.label ?? '') ? null : undefined) }),
})
eq('the run reports failed', dead.value?.status, 'failed')
eq('it still sealed', seals(dead.calls).length, 1)
check('and it sealed failed, not complete',
  seals(dead.calls)[0]?.includes('seal tour-dead failed false'), seals(dead.calls)[0])

group('tournament: an unapproved design decision never becomes an approval')
// A judged bracket picks the best of N; it never checks the winner against
// acceptance criteria, so approved=true here would be a forged review receipt.
const won = await runWorkflow(WF('tournament'), {
  args: { run_id: 'tour-2', prompt: 'x', num_attempts: 2, plugin_root: PLUGIN_ROOT },
  agent: mockAgent(),
})
check('a clean sweep still seals approved=false',
  seals(won.calls)[0]?.endsWith('complete false'), seals(won.calls)[0])

group('open-claude-design: critic approval is not gate approval')
const critiqued = await runWorkflow(WF('open-claude-design'), {
  args: { run_id: 'ocd-2', prompt: 'a landing page', discover_references: false, max_refinements: 1, plugin_root: PLUGIN_ROOT },
  agent: mockAgent(),
})
eq('the critic approved for export', critiqued.value?.approved_for_export, true)
check('but the run seals approved=false',
  seals(critiqued.calls)[0]?.endsWith('complete false'), seals(critiqued.calls)[0])
eq('and the result says no human reviewed it', critiqued.value?.human_reviewed, false)

group('classify-and-act: routes and acts, but certifies nothing')
// It has no review stage at all, so approved=true would mint the "independently
// reviewed" receipt for work no verifier read.
const classified = await runWorkflow(WF('classify-and-act'), {
  args: { run_id: 'ca-1', prompt: 'explain the auth flow', plugin_root: PLUGIN_ROOT },
  agent: mockAgent(),
})
eq('the run completes', classified.value?.status, 'complete')
eq('it registers the run', begins(classified.calls).length, 1)
eq('it seals once', seals(classified.calls).length, 1)
check('and it seals approved=false',
  seals(classified.calls)[0]?.includes('seal ca-1 complete false'), seals(classified.calls)[0])

group('loop-until-done: an independent evaluator is the one weak approval')
// done=true comes from an evaluator that did none of the work, so this run may
// seal approved=true — it is the only non-quorum workflow that does.
const looped = await runWorkflow(WF('loop-until-done'), {
  args: { run_id: 'lud-1', prompt: 'fix the flaky test', plugin_root: PLUGIN_ROOT },
  agent: mockAgent(),
})
eq('the run completes', looped.value?.status, 'complete')
check('it seals approved=true',
  seals(looped.calls)[0]?.includes('seal lud-1 complete true'), seals(looped.calls)[0])
check('the evaluator is a separate agent from the worker that did the work',
  looped.calls.some(x => /evaluate-1/.test(x.label ?? '')) &&
  looped.calls.some(x => /iteration-1/.test(x.label ?? '')))
check('and the evaluator is told it did not do the work',
  looped.calls.find(x => /evaluate-1/.test(x.label ?? ''))?.prompt.includes('You did NOT do the work'))

report()
