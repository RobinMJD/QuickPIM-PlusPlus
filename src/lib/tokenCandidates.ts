import {
  getGraphTokenAuthStrengthScore,
  getGraphTokenOverallScore,
  getGraphTokenTargetScore,
  type GraphTokenTarget
} from "./graphTokenCapabilities";
import { validateCapturedToken } from "./security";
import type { AccessSetupTarget, TokenKind } from "./types";

export interface SelectedPortalTokenCandidate {
  token: string;
  tokenKind: TokenKind;
  identity: string;
}

export interface StoredGraphTokenCandidate {
  token?: string;
  timestamp?: number;
  source?: string;
}

interface ValidatedCandidate extends SelectedPortalTokenCandidate {
  decoded: Record<string, unknown>;
}

interface IdentitySelection {
  identity: string;
  candidates: SelectedPortalTokenCandidate[];
  coverage: number;
  quality: number;
  latestExpiry: number;
  targetFreshness: number;
}

export function selectPortalTokenCandidates(
  tokens: string[],
  options: { preferredIdentity?: string; requiredTargets?: AccessSetupTarget[]; now?: number } = {}
): SelectedPortalTokenCandidate[] {
  const now = options.now ?? Date.now();
  const byIdentity = new Map<string, ValidatedCandidate[]>();

  [...new Set(tokens)].sort().forEach((token) => {
    for (const tokenKind of ["graph", "azureManagement"] as const) {
      const validation = validateCapturedToken(token, tokenKind, now);
      if (!validation.ok) continue;
      const identity = getCandidateIdentity(validation.decoded);
      if (!identity) continue;
      const candidates = byIdentity.get(identity) || [];
      candidates.push({ token, tokenKind, identity, decoded: validation.decoded });
      byIdentity.set(identity, candidates);
    }
  });

  const selections = [...byIdentity.entries()].map(([identity, candidates]) =>
    buildIdentitySelection(identity, candidates, options.requiredTargets)
  );
  if (!selections.length) {
    return [];
  }

  const preferredIdentity = options.preferredIdentity?.trim().toLowerCase();
  const preferred = preferredIdentity
    ? selections.find((selection) => selection.identity === preferredIdentity)
    : undefined;
  return (preferred || selections.sort(compareIdentitySelections)[0]).candidates;
}

export function selectBestStoredGraphTokenForTarget(
  candidates: StoredGraphTokenCandidate[],
  target: GraphTokenTarget,
  now = Date.now()
): StoredGraphTokenCandidate | undefined {
  return candidates
    .flatMap((candidate) => {
      if (!candidate.token) return [];
      const validation = validateCapturedToken(candidate.token, "graph", now);
      return validation.ok ? [{ candidate, decoded: validation.decoded }] : [];
    })
    .sort((left, right) =>
      getGraphTokenTargetScore(right.decoded, target) - getGraphTokenTargetScore(left.decoded, target)
      || getGraphTokenAuthStrengthScore(right.decoded) - getGraphTokenAuthStrengthScore(left.decoded)
      || (Number(right.decoded.exp) || 0) - (Number(left.decoded.exp) || 0)
      || (right.candidate.timestamp || 0) - (left.candidate.timestamp || 0)
      || String(left.candidate.token).localeCompare(String(right.candidate.token))
    )[0]?.candidate;
}

function buildIdentitySelection(
  identity: string,
  candidates: ValidatedCandidate[],
  requiredTargets?: AccessSetupTarget[]
): IdentitySelection {
  const graphCandidates = candidates.filter((candidate) => candidate.tokenKind === "graph");
  const azureCandidates = candidates.filter((candidate) => candidate.tokenKind === "azureManagement");
  const genericGraph = selectBestCandidate(graphCandidates, (candidate) => getGraphTokenOverallScore(candidate.decoded));
  const directoryGraph = selectTargetGraphCandidate(graphCandidates, "directoryRole");
  const pimGroupGraph = selectTargetGraphCandidate(graphCandidates, "pimGroup");
  const azure = selectBestCandidate(azureCandidates, () => 1);
  const selected = dedupeCandidates([genericGraph, directoryGraph, pimGroupGraph, azure]);
  const required = new Set(requiredTargets?.length ? requiredTargets : ["directoryRole", "pimGroup", "azureRole"]);
  const targetCandidates = [
    required.has("directoryRole") ? directoryGraph : undefined,
    required.has("pimGroup") ? pimGroupGraph : undefined,
    required.has("azureRole") ? azure : undefined
  ].filter((candidate): candidate is ValidatedCandidate => Boolean(candidate));
  const coverage = targetCandidates.length;
  const quality = candidateScore(genericGraph, (candidate) => getGraphTokenOverallScore(candidate.decoded))
    + candidateScore(directoryGraph, (candidate) => getGraphTokenTargetScore(candidate.decoded, "directoryRole"))
    + candidateScore(pimGroupGraph, (candidate) => getGraphTokenTargetScore(candidate.decoded, "pimGroup"))
    + Number(Boolean(azure));

  return {
    identity,
    candidates: selected.map(({ token, tokenKind, identity: candidateIdentity }) => ({
      token,
      tokenKind,
      identity: candidateIdentity
    })),
    coverage,
    quality,
    latestExpiry: Math.max(0, ...selected.map((candidate) => Number(candidate.decoded.exp) || 0)),
    targetFreshness: targetCandidates.length
      ? Math.min(...targetCandidates.map((candidate) => Number(candidate.decoded.exp) || 0))
      : 0
  };
}

function selectTargetGraphCandidate(
  candidates: ValidatedCandidate[],
  target: GraphTokenTarget
): ValidatedCandidate | undefined {
  return selectBestCandidate(
    candidates.filter((candidate) => getGraphTokenTargetScore(candidate.decoded, target) > 0),
    (candidate) => getGraphTokenTargetScore(candidate.decoded, target)
  );
}

function selectBestCandidate(
  candidates: ValidatedCandidate[],
  getScore: (candidate: ValidatedCandidate) => number
): ValidatedCandidate | undefined {
  return [...candidates].sort((left, right) =>
    getScore(right) - getScore(left)
    || getGraphAuthScore(right) - getGraphAuthScore(left)
    || (Number(right.decoded.exp) || 0) - (Number(left.decoded.exp) || 0)
    || left.token.localeCompare(right.token)
  )[0];
}

function dedupeCandidates(candidates: Array<ValidatedCandidate | undefined>): ValidatedCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate): candidate is ValidatedCandidate => {
    if (!candidate) return false;
    const key = `${candidate.tokenKind}:${candidate.token}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidateScore(
  candidate: ValidatedCandidate | undefined,
  getScore: (candidate: ValidatedCandidate) => number
): number {
  return candidate ? getScore(candidate) : 0;
}

function getGraphAuthScore(candidate: ValidatedCandidate): number {
  return candidate.tokenKind === "graph" ? getGraphTokenAuthStrengthScore(candidate.decoded) : 0;
}

function compareIdentitySelections(left: IdentitySelection, right: IdentitySelection): number {
  return right.coverage - left.coverage
    || right.targetFreshness - left.targetFreshness
    || right.quality - left.quality
    || right.latestExpiry - left.latestExpiry
    || left.identity.localeCompare(right.identity);
}

function getCandidateIdentity(decoded: Record<string, unknown>): string | undefined {
  return typeof decoded.tid === "string" && typeof decoded.oid === "string"
    ? `${decoded.tid.toLowerCase()}:${decoded.oid.toLowerCase()}`
    : undefined;
}
