export const meta = {
  name: 'open-claude-design',
  description: 'Design discovery → reference import → self-contained HTML preview → bounded critic refinement → rich HTML spec export (headless port of Atomic openClaudeDesign)',
  phases: [
    { title: 'Discovery', detail: 'expand the prompt into a structured design brief' },
    { title: 'References', detail: 'research 3-5 real-world reference designs (optional)' },
    { title: 'Preview', detail: 'generate a self-contained single-file HTML preview' },
    { title: 'Refine', detail: 'bounded critic loop: findings applied to the preview' },
    { title: 'Export', detail: 'derive a rich HTML handoff spec from the final preview' },
  ],
}

// args: { run_id, prompt, discover_references = true, max_refinements = 3 }
// HEADLESS adaptation of upstream open-claude-design: upstream runs a live HTML
// preview loop with a playwright-driven browser and a human-feedback long-poll
// gate between refinement rounds. In HEADLESS MODE upstream SKIPS that human
// feedback gate — this port implements exactly that variant, because Claude
// Code workflows cannot prompt the user mid-run. The human gate is replaced by
// a fresh schema-validated critic per round with a deterministic exit gate in
// JS; when the refinement budget is exhausted with blocking findings, the run
// still completes but surfaces approved_for_export: false (upstream surfaces
// the flag rather than failing).
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
    '/atomic:open-claude-design {"run_id":"ocd-1","prompt":"landing page for ..."}')
}
const A = atomicArgs(args)
if (!A.run_id) throw new Error('atomic: run_id required (e.g. ocd-landing-01)')
if (!/^[A-Za-z0-9._-]{1,64}$/.test(A.run_id))
  throw new Error('atomic: run_id must match [A-Za-z0-9._-], max 64 chars (no slashes, spaces, or quotes)')
if (!A.prompt) throw new Error('atomic: prompt required')
const DISCOVER_REFERENCES = A.discover_references !== false            // Atomic default true
const MAX_REFINEMENTS = Math.min(Math.max(A.max_refinements ?? 3, 0), 5) // Atomic default 3, clamp 0-5
const DIR = `.atomic-cc/runs/${A.run_id}`
const BRIEF = `${DIR}/design-brief.md`
const REFS = `${DIR}/references.md`
const PREVIEW = `${DIR}/preview.html`
const SPEC = `${DIR}/design-spec.html`

const BRIEF_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['audience', 'goals', 'constraints', 'style_direction', 'sections'],
  properties: {
    audience: { type: 'string' },
    goals: { type: 'array', minItems: 1, items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
    style_direction: { type: 'string' },
    sections: { type: 'array', minItems: 1, items: { type: 'string' } },
  },
}
const CRITIC_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['approved', 'findings', 'rationale'],
  properties: {
    approved: { type: 'boolean' },
    findings: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['severity', 'description'],
      properties: {
        severity: { enum: ['blocking', 'minor'] },
        description: { type: 'string' },
      } } },
    rationale: { type: 'string' },
  },
}

phase('Discovery')
const brief = await agent(
  `Design discovery for atomic open-claude-design run "${A.run_id}".
Expand this design prompt into a structured design brief: ${A.prompt}
Identify the audience, concrete goals, hard constraints, a style direction
(tone, layout language, color/typography direction), and the ordered list of
sections/screens the design needs. Be specific enough that a builder could
implement the design without asking questions.`,
  { schema: BRIEF_SCHEMA, label: 'discovery' })
if (!brief) throw new Error('atomic open-claude-design: discovery stage returned null')

await agent(
  `Atomic open-claude-design run "${A.run_id}": persist the design brief.
Write EXACTLY this path and no other file (create directories as needed): ${BRIEF}
Render this structured brief as readable markdown (headings for audience, goals,
constraints, style direction, sections), preserving every field verbatim:
${JSON.stringify(brief, null, 2)}
Return a one-line confirmation.`,
  { agentType: 'atomic:worker', label: 'brief:write' })

let referencesPath = null
if (DISCOVER_REFERENCES) {
  phase('References')
  const refs = await agent(
    `Reference import for atomic open-claude-design run "${A.run_id}".
Research 3-5 real-world reference designs/patterns relevant to this brief —
sites, design systems, or documented patterns. EVERY claim must cite a URL.
Brief:
${JSON.stringify(brief, null, 2)}
For each reference note: what it is (URL), which part of the brief it informs,
and the concrete pattern worth borrowing (layout, tokens, interaction).
Write your notes via your Write tool to EXACTLY this path and no other file
(create directories as needed): ${REFS}
Return a compact summary of the references found.`,
    { agentType: 'atomic:codebase-online-researcher', label: 'references' })
  if (refs) referencesPath = REFS
  else log('atomic open-claude-design: reference researcher returned null — proceeding without references')
} else {
  log('atomic open-claude-design: discover_references=false — skipping reference import')
}

phase('Preview')
await agent(
  `Atomic open-claude-design run "${A.run_id}": generate the live preview.
Read the design brief at ${BRIEF}${referencesPath ? ` and the reference notes at ${referencesPath}` : ''}.
Build a SELF-CONTAINED single-file HTML preview implementing the brief:
- ALL CSS and JS inline in the one file; NO external assets, fonts, CDNs, or images
  (use inline SVG / CSS where visuals are needed).
- Implement every section listed in the brief, in order, in the stated style direction.
Write it to EXACTLY this path and no other file: ${PREVIEW}
Return a one-line summary of what the preview contains.`,
  { agentType: 'atomic:worker', label: 'preview' })

// Headless refinement loop: fresh critic each round, deterministic gate in JS
// (upstream's human feedback long-poll gate is skipped in headless mode).
let refinements = 0
let approvedForExport = false
let lastCritique = null
for (let round = 0; ; round += 1) {
  const critique = await agent(
    `You are a FRESH design critic (round ${round}) for atomic open-claude-design run "${A.run_id}".
Read the preview at ${PREVIEW} and the design brief at ${BRIEF}.
Judge the preview strictly against the brief: every section present, constraints
respected, style direction followed, self-contained (no external assets).
Return approved=true only when the preview fully satisfies the brief. List each
concrete finding with severity "blocking" (violates the brief or breaks the page)
or "minor" (polish). Findings must be specific and actionable.`,
    { schema: CRITIC_SCHEMA, label: `critic:r${round}` })
  lastCritique = critique ?? lastCritique

  // Deterministic exit gate: approved AND no blocking findings.
  const blocking = (critique?.findings ?? []).filter(f => f.severity === 'blocking')
  if (critique && critique.approved && blocking.length === 0) {
    approvedForExport = true
    break
  }
  if (refinements >= MAX_REFINEMENTS) {
    // Budget exhausted with blockers: upstream surfaces the flag rather than failing.
    log(`atomic open-claude-design: refinement budget exhausted with ${blocking.length} blocking finding(s) — exporting with approved_for_export=false`)
    break
  }
  if (!critique)
    log(`atomic open-claude-design: critic round ${round} returned null — spending a refinement on the last known findings`)

  refinements += 1
  const findings = critique?.findings ?? lastCritique?.findings ?? []
  await agent(
    `Atomic open-claude-design run "${A.run_id}", refinement ${refinements} of ${MAX_REFINEMENTS}.
Apply ONLY the findings below to the preview at ${PREVIEW} — do not redesign or
expand scope, and keep the file self-contained (inline CSS/JS, no external assets).
Findings: ${JSON.stringify(findings, null, 2)}
Brief (unchanged, for context): ${BRIEF}
Return a one-line summary of the edits made.`,
    { agentType: 'atomic:worker', label: `refine:r${refinements}` })
}

phase('Export')
await agent(
  `Atomic open-claude-design run "${A.run_id}": export the handoff spec.
Read the FINAL preview at ${PREVIEW} and the brief at ${BRIEF}${referencesPath ? ` and the reference notes at ${referencesPath}` : ''}.
Write a rich, self-contained HTML handoff spec to EXACTLY this path and no other
file: ${SPEC}
The spec must document, derived from the final preview (not from assumptions):
- the design decisions made and why (tie them back to the brief),
- a component inventory (each component, its purpose, its states),
- the design tokens actually used: colors, typography, spacing,
- the preview itself, embedded (e.g. in an iframe via relative src "preview.html"
  or inlined) so the spec stands alone as a handoff document.
${approvedForExport ? '' : `State prominently near the top that the design was NOT approved by the critic
(approved_for_export=false) and list the outstanding findings: ${JSON.stringify(lastCritique?.findings ?? [], null, 2)}`}
Return a one-line confirmation.`,
  { agentType: 'atomic:worker', label: 'export' })

return {
  status: 'complete',
  preview_path: PREVIEW,
  spec_path: SPEC,
  approved_for_export: approvedForExport,
  refinements_completed: refinements,
  references_path: referencesPath,
}
