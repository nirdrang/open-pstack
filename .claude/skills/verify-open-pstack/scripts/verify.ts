import { classify, completeEvidence, newReceipt, requiredHarnesses } from './core.ts';
import { retainedFile, sha256 } from './io.ts';
import { REPO, type Driver, type GitHub, type Pull, type Receipt, type Registry } from './types.ts';

class HeadMoved extends Error {}
// Omit unsafe or oversized values whole rather than rewriting recorded evidence.
export const EVIDENCE_LIMIT = 160;
export const publishable = (text: string, limit = EVIDENCE_LIMIT): boolean => text.length <= limit && /^[\x20-\x7e]*$/.test(text) && !/[`<>]/.test(text);
const safe = (text: string, limit = EVIDENCE_LIMIT): string => publishable(text, limit) ? text : '[value omitted]';

/** Build the single structured public record for this run. Failure details remain private in receipt.json. */
export function evidence(receipt: Receipt): string {
  const failed = Boolean(receipt.failure);
  const lines = [
    '## Live evidence: Open Pstack',
    `- Candidate SHA: \`${receipt.sha}\``,
    `- Base SHA: \`${receipt.base}\``,
    `- Result: ${failed ? 'FAILED — verification did not complete; rerun required' : receipt.selection.noRuntime && !receipt.selfTest ? 'PASSED — no runtime change' : 'PASSED — named features verified'}`,
    `- Self-test: ${receipt.selfTest ? failed ? 'required in both harnesses' : 'completed in both harnesses' : 'not requested'}`,
    `- Publisher revision: ${receipt.publisherRevision ? `\`${receipt.publisherRevision}\`` : 'not supplied'}`,
    `- Evidence-set SHA-256: \`${sha256(JSON.stringify({ installations: receipt.installations, observations: receipt.observations }))}\``,
  ];
  if (!failed) {
    for (const install of receipt.installations) {
      lines.push(`- Installation (${install.harness}): CLI ${safe(install.cliVersion)}, plugin ${safe(install.pluginVersion)}, candidate \`${install.sha}\`, tree \`${install.treeHash}\`.`);
    }
    let shown = 0;
    for (const record of receipt.observations) {
      const line = `- Observation (${record.harness} / ${safe(record.feature, 72)}): surface ${safe(record.surface)}; action ${safe(record.action)}; result ${safe(record.observed)}; ${record.assertions.length} assertions machine-checked; transcript SHA-256 \`${record.transcriptHash}\`; artifact-set SHA-256 \`${sha256(JSON.stringify(record.artifacts))}\`.`;
      if (lines.join('\n').length + line.length > 48000) break;
      lines.push(line); shown++;
    }
    if (shown < receipt.observations.length) lines.push(`- Additional observations: ${receipt.observations.length - shown} retained privately; bound by the evidence-set digest.`);
  }
  lines.push('- Policy: every new head requires a fresh run; this verifier does not change PR state, queue, or merge.');
  return lines.join('\n');
}

export async function revalidateEvidence(receipt: Receipt): Promise<void> {
  for (const record of receipt.observations) {
    const transcript = await retainedFile(receipt.artifactRoot, record.transcript);
    if (transcript.path !== record.transcript || transcript.sha256 !== record.transcriptHash) throw new Error('Retained transcript changed after acceptance');
    for (const artifact of record.artifacts) {
      const actual = await retainedFile(receipt.artifactRoot, artifact.path);
      if (actual.path !== artifact.path || actual.sha256 !== artifact.sha256) throw new Error('Retained artifact changed after acceptance');
    }
  }
}

type VerifyOptions = {
  pr: number;
  selfTest: boolean;
  /** `<harness>:<feature>` checks the agent named for the PR's changed behavior. */
  features: string[];
  root: string;
  registry: Registry;
  github: GitHub;
  driver: Driver;
  persist: (receipt: Receipt) => Promise<void>;
  publisherRevision?: string;
};

export async function verify(options: VerifyOptions): Promise<Receipt> {
  const { github, driver, persist } = options;
  const initial = await github.pull(options.pr);
  if (initial.state !== 'open' || initial.headRepo !== REPO) throw new Error('Require an open same-repository PR');
  const receipt = newReceipt(options.pr, initial.head.sha, initial.base.sha, options.selfTest, options.root, options.publisherRevision);
  let successAttempted = false, commentAttempted = false, cleanupComplete = false, cleanupFailed = false;
  const cleanup = async (): Promise<void> => {
    if (cleanupComplete) return;
    try { await driver.cleanup?.(receipt); }
    catch (error) { cleanupFailed = true; throw error; }
    cleanupComplete = true;
    receipt.cleanup = 'Setup files restored and verified; run-owned Codex home removed; private raw evidence retained';
  };
  const current = async (): Promise<Pull> => {
    const pull = await github.pull(receipt.pr);
    if (pull.head.sha !== receipt.sha || pull.base.sha !== receipt.base || pull.state !== 'open' || pull.headRepo !== REPO) throw new HeadMoved('PR head/base or open repository identity changed; run again');
    return pull;
  };
  const phase = async (next: Receipt['phase']): Promise<void> => {
    receipt.phase = next;
    await persist(receipt);
    await current();
  };
  const publishComment = async (): Promise<void> => {
    const body = evidence(receipt);
    commentAttempted = true;
    receipt.commentUrl = await github.comment(receipt.pr, body);
    await persist(receipt);
  };
  const appendFailure = (label: string, error: unknown): void => {
    receipt.failure = `${receipt.failure}; ${label}: ${error instanceof Error ? error.message : String(error)}`;
  };
  await phase('classify');
  receipt.selection = classify(await github.files(receipt.base, receipt.sha), options.registry);
  if (receipt.selection.features.includes('project-skill') && receipt.publisherRevision !== receipt.sha) {
    throw new Error('Verifier-changing PRs must run from a checkout of the candidate head; rerun from that checkout');
  }
  if (!receipt.selection.noRuntime && !options.features.length) throw new Error('A runtime change requires at least one --feature <harness>:<feature>');
  // Only the named features run; classification gates runtime changes and unmapped paths.
  // Verifier and instruction changes keep their native project-skill proof whatever is named.
  const project = receipt.selection.features.includes('project-skill') ? ['claude:project-skill', 'codex:project-skill'] : [];
  receipt.selection.features = receipt.selection.noRuntime ? [] : [...new Set([...options.features, ...project])];
  if (requiredHarnesses(receipt).length) await driver.preflight(receipt);
  try {
    await current(); await persist(receipt);
    if (!receipt.selection.noRuntime || receipt.selfTest) {
      await phase('prepare'); receipt.installations = await driver.prepare(receipt); await current(); await persist(receipt);
      await phase('exercise'); receipt.observations = await driver.exercise(receipt); await current(); await persist(receipt);
    }
    await cleanup();
    completeEvidence(receipt);
    await phase('publish'); await revalidateEvidence(receipt); await current();
    await publishComment();
    await current(); await revalidateEvidence(receipt);
    successAttempted = true;
    await github.status(receipt.sha, 'success', receipt.commentUrl!, receipt.selection.noRuntime && !receipt.selfTest ? 'No runtime change' : 'Named features passed');
    receipt.status = 'success'; await persist(receipt); await current(); await revalidateEvidence(receipt);
    return receipt;
  } catch (error) {
    receipt.failure = error instanceof Error ? error.message : String(error);
    receipt.phase = error instanceof HeadMoved ? 'head-moved' : 'failed';
    try { await cleanup(); }
    catch (cleanupError) {
      receipt.cleanup = `FAILED: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
      appendFailure('setup restoration or Codex cleanup', cleanupError);
    }
    try { await persist(receipt); }
    catch (persistError) { appendFailure('persist failure receipt', persistError); }

    // Failed setup restoration or Codex auth-link cleanup forbids all publication.
    if (cleanupComplete && !cleanupFailed) {
      if (!commentAttempted) {
        try { await current(); await publishComment(); }
        catch (publicationError) { appendFailure('publish failure evidence', publicationError); }
      }
      try {
        await github.status(receipt.sha, 'failure', receipt.commentUrl ?? `https://github.com/${REPO}/pull/${receipt.pr}`, successAttempted ? 'Verification aborted; rerun required' : 'Verification failed; rerun required');
        receipt.status = 'failure';
      } catch (statusError) { appendFailure('publish failure live-gate', statusError); }
    }
    try { await persist(receipt); }
    catch (persistError) { appendFailure('persist final failure receipt', persistError); }
    throw new Error(receipt.failure);
  }
}
