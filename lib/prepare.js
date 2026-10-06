'use strict';

const fs = require('fs');
const path = require('path');
const { BlockedError } = require('./errors');
const { readJson, writeJson, isInside, now } = require('./fsutil');
const { checkRun } = require('./check');
const { checkSpec, readCurrentSpec } = require('./spec');
const { checkPlan, currentPlanRevision } = require('./plan');
const { checkDev } = require('./scope');
const { computeCodebase, sameRef } = require('./codebase');
const { preexistingProblems, acceptanceIds } = require('./verify');
const { problemEvidenceProblems } = require('./problems');
const { captureReviewBinding, bindingProblems, streamHash } = require('./review-binding');
const { loadReview, unresolvedBlocking, flagTrue } = require('./review');
const { reviewBindingProblems } = require('./review-binding');

const PREPARE_NAME = /^prepare-v([1-9][0-9]*)\.json$/;

function latestPrepare(runDir) {
  const dir = path.join(runDir, 'review');
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir).filter((name) => PREPARE_NAME.test(name))
    .sort((a, b) => Number(a.match(PREPARE_NAME)[1]) - Number(b.match(PREPARE_NAME)[1]));
  if (!names.length) return null;
  const rel = `review/${names[names.length - 1]}`;
  try { return { rel, receipt: readJson(path.join(runDir, rel)) }; }
  catch (error) { return { rel, error }; }
}

function validReference(repoRoot, runDir, value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) return false;
  if (value.split(/[\\/]/).some((part) => part === '..' || part === '.')) return false;
  for (const root of [repoRoot, runDir]) {
    const abs = path.resolve(root, value);
    try {
      if (isInside(fs.realpathSync(abs), fs.realpathSync(root)) && fs.statSync(abs).isFile()) return true;
    } catch { /* Try the other root. */ }
  }
  return false;
}

function string(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new BlockedError(`${label} must be a nonempty string`);
  return value.trim();
}

function validateInput(repoRoot, runDir, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BlockedError('review input must be a JSON object');
  const allowed = new Set(['read_scope', 'findings', 'unconfirmed']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new BlockedError(`review input has unknown field ${key}`);
  if (!Array.isArray(input.read_scope)) throw new BlockedError('read_scope must be an array');
  if (!Array.isArray(input.findings)) throw new BlockedError('findings must be an array');
  const read_scope = input.read_scope.map((value) => {
    const ref = string(value, 'read_scope entry');
    if (!validReference(repoRoot, runDir, ref)) throw new BlockedError(`read_scope reference is not a file: ${ref}`);
    return ref;
  });
  const findings = input.findings.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new BlockedError(`findings[${index}] must be an object`);
    for (const key of Object.keys(entry)) if (!['claim', 'references', 'impact'].includes(key)) throw new BlockedError(`findings[${index}] has unknown field ${key}`);
    if (!Array.isArray(entry.references) || !entry.references.length) throw new BlockedError(`findings[${index}].references must contain a file`);
    const references = entry.references.map((value) => {
      const ref = string(value, `findings[${index}].references entry`);
      if (!validReference(repoRoot, runDir, ref)) throw new BlockedError(`finding reference is not a file: ${ref}`);
      return ref;
    });
    return { claim: string(entry.claim, `findings[${index}].claim`), references, impact: string(entry.impact, `findings[${index}].impact`) };
  });
  let unconfirmed = null;
  if (Object.prototype.hasOwnProperty.call(input, 'unconfirmed')) {
    if (!Array.isArray(input.unconfirmed)) throw new BlockedError('unconfirmed must be an array');
    unconfirmed = input.unconfirmed.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new BlockedError(`unconfirmed[${index}] must be an object`);
      for (const key of Object.keys(entry)) if (!['claim', 'reason', 'evidence', 'impact'].includes(key)) throw new BlockedError(`unconfirmed[${index}] has unknown field ${key}`);
      return {
        claim: string(entry.claim, `unconfirmed[${index}].claim`),
        reason: string(entry.reason, `unconfirmed[${index}].reason`),
        evidence: string(entry.evidence, `unconfirmed[${index}].evidence`),
        impact: string(entry.impact, `unconfirmed[${index}].impact`),
      };
    });
  }
  return { read_scope, findings, unconfirmed };
}

function fileHash(runDir, rel) {
  const file = path.join(runDir, rel);
  return fs.existsSync(file) && fs.statSync(file).isFile() ? streamHash(file) : null;
}

function sourceBindings(repoRoot, runDir, manifest) {
  return (manifest.sources || []).map((source) => {
    const file = source.origin === 'stdin' ? path.join(runDir, source.path) : path.join(repoRoot, source.path);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new BlockedError(`source is missing: ${source.path}`);
    return { path: source.path, hash: streamHash(file), id: source.id };
  });
}

function captureInputs(repoRoot, runDir, manifest) {
  const advisors = manifest.route === 'selected_advisors';
  const spec = readCurrentSpec(runDir);
  const planRevision = advisors ? null : currentPlanRevision(runDir);
  return {
    sources: sourceBindings(repoRoot, runDir, manifest),
    spec: fileHash(runDir, 'spec/execution-spec.md'),
    spec_frozen: spec.revision ? fileHash(runDir, `spec/revisions/r${spec.revision}.md`) : null,
    plan: advisors ? null : fileHash(runDir, 'plan/plan.md'),
    plan_frozen: planRevision ? fileHash(runDir, `plan/revisions/r${planRevision}.md`) : null,
    result: advisors ? null : captureReviewBinding(repoRoot, runDir, manifest),
  };
}

function acceptanceEvidenceProblems(repoRoot, runDir, runId, manifest) {
  const problems = [];
  for (const ac of acceptanceIds(runDir)) {
    const rel = `evidence/${ac}/meta.json`;
    try {
      const meta = readJson(path.join(runDir, rel));
      if (meta.status !== 'pass' && meta.preexisting !== true) problems.push(`${runId} ${ac} is ${meta.status || 'not_run'}`);
      if (meta.stale === true) problems.push(`${runId} ${ac} evidence is stale`);
      const workspace = (manifest.workspaces || []).find((item) => item.id === meta.workspace) || (manifest.workspaces || [])[0];
      if (!workspace || !meta.codebase_ref || !sameRef(meta.codebase_ref, computeCodebase(repoRoot, workspace.path || '.').codebase_ref)) {
        problems.push(`${runId} ${ac} evidence does not match current codebase`);
      }
      if (!fs.existsSync(path.join(runDir, 'evidence', ac, 'output.txt'))) problems.push(`${runId} ${ac} has no output evidence`);
    } catch (error) {
      problems.push(`${runId} ${rel}: ${error.message}`);
    }
  }
  return problems;
}

function checked(name, run) {
  try {
    const problems = run();
    return { name, status: problems.length ? 'issues' : 'pass', problems };
  } catch (error) {
    return { name, status: 'issues', problems: [error.message] };
  }
}

function runChecks(repoRoot, runDir, runId, manifest, paths) {
  const checks = [checked('run_integrity', () => checkRun(runDir, runId))];
  const specExists = fs.existsSync(path.join(runDir, 'spec', 'execution-spec.md'));
  if (specExists || manifest.route !== 'selected_advisors') {
    checks.push(checked('spec', () => checkSpec(runDir, runId).problems));
  }
  if (manifest.route !== 'selected_advisors') {
    checks.push(checked('plan', () => checkPlan(runDir, runId, repoRoot).problems));
    checks.push(checked('scope', () => checkDev(repoRoot, runDir, runId, paths).problems));
    checks.push(checked('acceptance_evidence', () => acceptanceEvidenceProblems(repoRoot, runDir, runId, manifest)));
    checks.push(checked('preexisting_evidence', () => preexistingProblems(runDir, runId)));
  }
  checks.push(checked('problem_evidence', () => problemEvidenceProblems(runDir, runId)));
  return checks;
}

function adoptedReviews(repoRoot, runDir, runId, manifest) {
  if (manifest.route === 'selected_advisors') return [];
  const revision = currentPlanRevision(runDir);
  const review = loadReview(runDir, 'result-review', revision);
  if (!review.exists || review.verdict !== 'READY' || unresolvedBlocking(review.findings).length) return [];
  if (review.fields.reviewer_kind !== 'human' && !(review.fields.reviewer_kind === 'agent' && flagTrue(review.fields.independent))) return [];
  if (require('./reviewer-source').checkReviewSource(review).status !== 'verified') return [];
  if (reviewBindingProblems(repoRoot, runDir, review, manifest).length) return [];
  const { resultReviewProblems } = require('./done');
  if (resultReviewProblems(runDir, runId, manifest, repoRoot).length) return [];
  const hash = fileHash(runDir, review.rel);
  const binding_hash = fileHash(runDir, review.rel.replace(/\.md$/, '.binding.json'));
  if (!hash || !binding_hash) return [];
  return [{ path: review.rel, hash, binding_hash }];
}

function writePrepare(repoRoot, runDir, runId, manifest, paths, rawInput) {
  const input = validateInput(repoRoot, runDir, rawInput);
  const checks = runChecks(repoRoot, runDir, runId, manifest, paths);
  const inputs = captureInputs(repoRoot, runDir, manifest);
  const adopted_reviews = adoptedReviews(repoRoot, runDir, runId, manifest);
  const latest = latestPrepare(runDir);
  const version = latest ? Number(path.basename(latest.rel).match(PREPARE_NAME)[1]) + 1 : 1;
  const rel = `review/prepare-v${version}.json`;
  const receipt = {
    version: 1,
    kind: 'review-prepare',
    status: 'agent_preflight',
    created_at: now(),
    run_id: runId,
    route: manifest.route,
    read_scope: input.read_scope,
    findings: input.findings,
    research_recorded: input.unconfirmed !== null,
    unconfirmed: input.unconfirmed || [],
    inputs,
    adopted_reviews,
    checks,
  };
  writeJson(path.join(runDir, rel), receipt);
  return { rel, receipt, problems: checks.flatMap((entry) => entry.problems) };
}

function prepareProblems(repoRoot, runDir, runId, manifest) {
  const latest = latestPrepare(runDir);
  if (!latest) return [`${runId} review prepare is missing`];
  if (latest.error) return [`${runId} ${latest.rel}: ${latest.error.message}`];
  const { receipt, rel } = latest;
  if (!receipt || receipt.version !== 1 || receipt.kind !== 'review-prepare' || receipt.run_id !== runId || receipt.route !== manifest.route) {
    return [`${runId} ${rel}: receipt is invalid`];
  }
  if (!receipt.inputs || typeof receipt.inputs !== 'object' || !Array.isArray(receipt.adopted_reviews)) {
    return [`${runId} ${rel}: receipt inputs are invalid`];
  }
  const problems = [];
  const required = ['run_integrity', 'problem_evidence'];
  if (manifest.route !== 'selected_advisors') {
    required.push('spec', 'plan', 'scope', 'acceptance_evidence', 'preexisting_evidence');
  } else if (fs.existsSync(path.join(runDir, 'spec', 'execution-spec.md'))) {
    required.push('spec');
  }
  const seen = new Set();
  for (const check of Array.isArray(receipt.checks) ? receipt.checks : []) {
    if (!check || typeof check.name !== 'string' || seen.has(check.name)
      || !Array.isArray(check.problems) || (check.status !== 'pass' && check.status !== 'issues')) {
      problems.push(`${runId} ${rel}: check record is invalid`);
      continue;
    }
    seen.add(check.name);
    if (check.status !== 'pass' || check.problems.length) problems.push(`${runId} ${rel}: ${check.name} preflight has issues`);
  }
  if (!Array.isArray(receipt.checks) || required.some((name) => !seen.has(name))) {
    problems.push(`${runId} ${rel}: required checks are missing`);
  }
  try {
    const fresh = captureInputs(repoRoot, runDir, manifest);
    if (JSON.stringify(receipt.inputs && receipt.inputs.sources) !== JSON.stringify(fresh.sources)
      || receipt.inputs.spec !== fresh.spec || receipt.inputs.spec_frozen !== fresh.spec_frozen
      || receipt.inputs.plan !== fresh.plan || receipt.inputs.plan_frozen !== fresh.plan_frozen) {
      problems.push(`${runId} ${rel}: Spec, Plan or sources changed`);
    }
    if (fresh.result) {
      for (const issue of bindingProblems(repoRoot, runDir, manifest, receipt.inputs.result)) {
        problems.push(`${runId} ${rel}: ${issue}`);
      }
    }
  } catch (error) {
    problems.push(`${runId} ${rel}: cannot verify inputs: ${error.message}`);
  }
  for (const adopted of receipt.adopted_reviews || []) {
    if (!adopted || typeof adopted.path !== 'string' || !/^review\/result-review-r[1-9][0-9]*\.md$/.test(adopted.path)
      || typeof adopted.hash !== 'string' || typeof adopted.binding_hash !== 'string') {
      problems.push(`${runId} ${rel}: adopted review record is invalid`);
      continue;
    }
    if (fileHash(runDir, adopted.path) !== adopted.hash
      || fileHash(runDir, adopted.path.replace(/\.md$/, '.binding.json')) !== adopted.binding_hash) {
      problems.push(`${runId} ${rel}: adopted review ${adopted.path} changed`);
    }
  }
  return problems;
}

module.exports = { latestPrepare, validateInput, writePrepare, prepareProblems };
