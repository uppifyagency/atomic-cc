export const meta = {
  name: 'fan-out-synthesize',
  description: 'Partition → bounded independent evidence branches (one artifact file each) → manifest barrier → artifact-reading synthesis (port of Atomic fanOutAndSynthesize)',
  phases: [
    { title: 'Partition', detail: 'split the task into independent evidence-producing partitions' },
    { title: 'Fan-out', detail: 'one branch per partition, each writing a standalone artifact file' },
    { title: 'Manifest', detail: 'barrier: partition plan + manifest.json listing every branch artifact' },
    { title: 'Synthesize', detail: 'reads the manifest and the artifact FILES, not inline summaries' },
  ],
}

// Port of upstream packages/workflows/builtin/fan-out-and-synthesize*.ts.
//
// The barrier upstream relies on is handoff BY FILE: each branch writes a
// standalone artifact, a manifest.json enumerates them, and the synthesizer is
// told to read the manifest first and then every listed artifact. That is what
// lets a synthesizer audit a branch "without its conversation context" — so no
// branch output is passed inline here, and nothing is truncated.
//
// Branches are INVESTIGATIVE in upstream (branchPrompt: "Investigate only
// <label>"): they produce evidence artifacts and do not mutate the repository.
// That instruction is a prompt, though, and branch agents run with the default
// write-capable tool set — so the run still registers with the commit gate
// (in_progress denies a stray commit) and seals a terminal status before
// returning. `approved` is always false: an investigation authorizes nothing.
//
// CC adaptations (declared):
// - Workflow JS has no fs, so the partition plan and manifest bytes are
//   composed here and transcribed by the 'atomic:scribe' agent (chartered to
//   copy, never author). Upstream writes them from TypeScript.
// - Upstream's `output`/`outputMode: "file-only"` per task becomes an explicit
//   "write exactly this path, return only a pointer" instruction, so branch
//   text never floods the caller's context.

// args: { run_id, prompt, max_branches = 4, max_concurrency = 4, plugin_root? }
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
  throw new Error('atomic: run_id must match [A-Za-z0-9._-], max 64 chars')
const PROMPT = String(A.prompt ?? '').trim()
if (!PROMPT) throw new Error('atomic: prompt required')
// Upstream schema bound: 1..12 partitions; default max_branches/max_concurrency 4.
const MAX_BRANCHES = Math.min(Math.max(A.max_branches ?? 4, 1), 12)
const MAX_CONCURRENCY = Math.min(Math.max(A.max_concurrency ?? 4, 1), 12)
const ARTIFACT_DIR = `.atomic-cc/runs/${A.run_id}/fan-out`
// Gate transitions go only through the plugin CLI; direct writes to
// run-state.json / approval.json are denied by the tamper-guard hook. The
// command is issued by the scribe (transcribe-and-run, never author), so no
// write-capable agent is handed the gate.
const PLUGIN_ROOT = typeof A.plugin_root === 'string' ? A.plugin_root.trim() : ''
// F10 (independent audit, 2026-08-12): the gate used to be OPT-IN. Every gating
// path in this file is conditional on plugin_root, and plugin_root appeared in no
// usage example anywhere in the docs — so a user who followed the documentation
// got no registration, no commit gate, no seal and no stop guard, while the docs
// asserted the opposite. It now fails CLOSED: a run that cannot register refuses
// to start rather than running ungated while claiming to be gated.
if (!PLUGIN_ROOT) throw new Error(
  'atomic: plugin_root is required and was not supplied.\n' +
  'Without it this run cannot register with the commit gate, so nothing would be gated, ' +
  'sealed, or guarded by the Stop hook — the run would look supervised and be unsupervised.\n' +
  'Pass the plugin install path, e.g.\n' +
  '  {"run_id": "...", "plugin_root": "/path/to/atomic-cc"}\n' +
  'The SessionStart notice prints the exact path for this session; `claude plugin list` also shows it.')
// PLUGIN_ROOT is guaranteed non-empty by the fail-closed check above, so this
// never returns null: there is no ungated mode left for a reader to infer.
const runStateCmd = (sub) => `"${PLUGIN_ROOT}/bin/run-state.sh" ${sub}`
async function runState(sub, label) {
  const cmd = runStateCmd(sub)
  await agent(
    `Run the following command EXACTLY as written, once, and report its output verbatim.
Write no files and modify nothing.

--- RUN COMMAND (verbatim) ---
${cmd}`,
    { agentType: 'atomic:scribe', label })
}
const PARTITION_PATH = `${ARTIFACT_DIR}/partition-plan.json`
const MANIFEST_PATH = `${ARTIFACT_DIR}/manifest.json`
const SYNTHESIS_PATH = `${ARTIFACT_DIR}/synthesis.md`

const GROUNDED_REPORTING = 'Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.'
const READABLE_REPORT = 'Lead with the outcome. Keep facts, decisions, caveats, and next steps; drop background and repetition. Use complete, readable sentences rather than compressed fragments.'

// port of upstream safeName(): "NN-slug", 1-indexed and zero-padded
function safeName(value, index) {
  const normalized = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `${String(index + 1).padStart(2, '0')}-${normalized || 'branch'}`
}

phase('Partition')
// Registered before any stage that can write, so the gate covers the whole run.
await runState(`begin ${A.run_id}`, 'gate:begin')
const plan = await agent(
  `<role>
You partition work into independent evidence-producing branches.
</role>

<success_criteria>
The plan has between 1 and ${MAX_BRANCHES} non-overlapping partitions whose labels and objectives are self-contained.
</success_criteria>

<decision_rules>
Split by files, sources, claims, candidates, or work items that can be evaluated independently. Avoid duplicate scope and identify boundaries explicitly. Stop when every required part of the task belongs to one partition.
</decision_rules>

<output_format>
Return only the structured result requested by the schema, with concise labels and self-contained objectives.
</output_format>

<objective>
Partition this task: ${PROMPT}
</objective>`,
  { schema: { type: 'object', additionalProperties: false, required: ['partitions'],
      properties: { partitions: { type: 'array', minItems: 1, maxItems: MAX_BRANCHES,
        items: { type: 'object', additionalProperties: false, required: ['label', 'objective'],
          properties: { label: { type: 'string', minLength: 1 },
            objective: { type: 'string', minLength: 1 } } } } } },
    label: 'partition', phase: 'Partition' })

// port of upstream parsedPartitions(): a missing or unusable plan degrades to
// the whole task as one partition. The workflow always proceeds.
function parsedPartitions(value, limit) {
  const fallback = [{ label: 'whole-task', objective: PROMPT }]
  if (!value || typeof value !== 'object' || !Array.isArray(value.partitions)) return fallback
  const result = []
  for (const candidate of value.partitions) {
    if (!candidate || typeof candidate !== 'object') continue
    const label = String(candidate.label ?? '').trim()
    const objective = String(candidate.objective ?? '').trim()
    if (label !== '' && objective !== '') result.push({ label, objective })
    if (result.length >= limit) break
  }
  return result.length > 0 ? result : fallback
}
const partitions = parsedPartitions(plan, MAX_BRANCHES)
const branchPaths = partitions.map((p, i) => `${ARTIFACT_DIR}/branch-${safeName(p.label, i)}.md`)

// The partition plan lands before the branches run, exactly as upstream writes
// it before ctx.parallel: branches read it to see the boundaries they must not
// cross.
const persist = (label, files, phaseName) => agent(
  `Transcribe the following artifacts exactly as given (byte-for-byte, create directories as needed). Do not author, reformat, or annotate content.\n\n${
    files.map(f => `--- WRITE FILE: ${f.path} ---\n${f.content}\n--- END FILE ---`).join('\n\n')}`,
  { agentType: 'atomic:scribe', label: `persist:${label}`, phase: phaseName })

await persist('partition-plan', [{ path: PARTITION_PATH,
  content: JSON.stringify({ task: PROMPT, partitions }, null, 2) }], 'Partition')

phase('Fan-out')
// Bounded fan-out: upstream passes concurrency = min(max_concurrency,
// partitions.length); batching here enforces the same bound under CC's own cap.
const thunks = partitions.map((partition, index) => () =>
  agent(
    `<overall_task>
${PROMPT}
</overall_task>

<role>
You own one independent branch of a larger task. Your artifact lets a synthesizer audit this branch without its conversation context.
</role>

<success_criteria>
Cite concrete files, sources, commands, or other observable evidence, distinguish findings from uncertainty, and produce a standalone artifact.
</success_criteria>

<boundaries>
The partition plan is at ${PARTITION_PATH}. Investigate ONLY your own partition; another branch owns each other partition, and duplicated scope corrupts the synthesis.
This is an investigation branch: produce evidence, do not implement changes to the repository.
</boundaries>

<stop_rules>
Stop when the branch objective is supported or when unresolved uncertainty and the evidence needed to resolve it are explicit.
</stop_rules>

<artifact_contract>
Write your standalone Markdown artifact to EXACTLY this path and no other file: ${branchPaths[index]}
Return only a one-line pointer to that path as your final message: the synthesizer reads the file, so do not repeat its contents.
</artifact_contract>

<output_format>
Markdown with Scope, Findings, Evidence, Conflicts or uncertainty, and Recommendations headings. ${READABLE_REPORT}
${GROUNDED_REPORTING}
</output_format>

<branch>
Investigate only ${partition.label}: ${partition.objective}
</branch>`,
    { label: `branch-${safeName(partition.label, index)}`, phase: 'Fan-out' }))

const branchResults = []
for (let i = 0; i < thunks.length; i += MAX_CONCURRENCY) {
  branchResults.push(...await parallel(thunks.slice(i, i + MAX_CONCURRENCY)))
}

// The manifest is the barrier: it exists only after every branch settled, and
// it records which branches completed, so the synthesizer can neither omit a
// completed branch nor invent a missing one.
phase('Manifest')
const branchEntries = partitions.map((partition, index) => ({
  ...partition,
  artifact_path: branchPaths[index],
  completed: branchResults[index] !== null && branchResults[index] !== undefined,
}))
const completedCount = branchEntries.filter(b => b.completed).length
if (completedCount < branchEntries.length) {
  log(`fan-out: ${branchEntries.length - completedCount}/${branchEntries.length} branch(es) did not complete; the manifest marks them completed=false and the synthesis must not treat them as covered.`)
}
await persist('manifest', [{ path: MANIFEST_PATH, content: JSON.stringify({
  task: PROMPT, partition_plan: PARTITION_PATH, branches: branchEntries,
  branches_planned: branchEntries.length, branches_completed: completedCount,
}, null, 2) }], 'Manifest')

phase('Synthesize')
const synthesis = await agent(
  `<artifact_contract>
Read ${MANIFEST_PATH} first, then read every branch artifact listed there whose completed flag is true. Do not omit a completed branch and do not assume access to branch conversations.
A branch listed with completed=false produced no artifact: report it as an uncovered partition under Remaining uncertainty rather than inferring its content.
Write the final synthesis to ${SYNTHESIS_PATH} and return it as your final message.
</artifact_contract>

<role>
You synthesize independent branch artifacts at a strict barrier. The final reader needs conclusions traceable to branch evidence rather than majority vote.
</role>

<success_criteria>
Deduplicate overlapping findings, explicitly resolve or preserve conflicting claims, retain material uncertainty, and cite branch labels and artifact paths for important conclusions.
</success_criteria>

<stop_rules>
Stop after every completed branch is accounted for and each material conflict is resolved or preserved as uncertainty.
</stop_rules>

<output_format>
Markdown with Executive synthesis, Consolidated findings, Conflicts and resolutions, Evidence index, and Remaining uncertainty headings. ${READABLE_REPORT}
${GROUNDED_REPORTING}
</output_format>

<objective>
Produce the final answer for: ${PROMPT}
</objective>`,
  { label: 'synthesize', phase: 'Synthesize' })

// approved=false: an investigation produces evidence, never a reviewed change,
// so this run must not authorize a commit.
await runState(`seal ${A.run_id} complete false`, 'gate:seal')

return {
  partitions: partitions.map(p => p.label),
  branches_planned: branchEntries.length,
  branches_completed: completedCount,
  branch_artifact_paths: branchPaths,
  partition_plan_path: PARTITION_PATH,
  manifest_path: MANIFEST_PATH,
  synthesis_path: SYNTHESIS_PATH,
  result: synthesis === null ? 'Synthesis stage produced no result; branch artifacts remain on disk.' : String(synthesis),
}
