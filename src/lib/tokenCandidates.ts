import {
  getGraphTokenAuthStrengthScore,
  getGraphTokenOverallScore,
  getGraphTokenTargetScore,
  type GraphTokenTarget
} from "./graphTokenCapabilities";
import { validateCapturedToken } from "./security";
import type { TokenKind } from "./types";

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
  index: number;
}

interface IdentitySelection {
  identity: string;
  candidates: SelectedPortalTokenCandidate[];
  coverage: number;
  quality: number;
  latestExpiry: number;
}

export function selectPortalTokenCandidates(
  tokens: string[],
  options: { preferredIdentity?: string; now?: number } = {}
): SelectedPortalTokenCandidate[] {
  const now = options.now ?? Date.now();
  const byIdentity = new Map<string, ValidatedCandidate[]>();

  tokens.forEach((token, index) => {
    for (const tokenKind of ["graph", "azureManagement"] as const) {
      const validation = validateCapturedToken(token, tokenKind, now);
      if (!validation.ok) continue;
      const identity = getCandidateIdentity(validation.decoded);
      if (!identity) continue;
      const candidates = byIdentity.get(identity) || [];
      candidates.push({ token, tokenKind, identity, decoded: validation.decoded, index });
      byIdentity.set(identity, candidates);
    }
  });

  const selections = [...byIdentity.entries()].map(([identity, candidates]) =>
    buildIdentitySelection(identity, candidates)
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
    .flatMap((candidate, index) => {
      if (!candidate.token) return [];
      const validation = validateCapturedToken(candidate.token, "graph", now);
      return validation.ok ? [{ candidate, decoded: validation.decoded, index }] : [];
    })
    .sort((left, right) =>
      getGraphTokenTargetScore(right.decoded, target) - getGraphTokenTargetScore(left.decoded, target)
      || getGraphTokenAuthStrengthScore(right.decoded) - getGraphTokenAuthStrengthScore(left.decoded)
      || (Number(right.decoded.exp) || 0) - (Number(left.decoded.exp) || 0)
      || (right.candidate.timestamp || 0) - (left.candidate.timestamp || 0)
      || left.index - right.index
    )[0]?.candidate;
}

function buildIdentitySelection(identity: string, candidates: ValidatedCandidate[]): IdentitySelection {
  const graphCandidates = candidates.filter((candidate) => candidate.tokenKind === "graph");
  const azureCandidates = candidates.filter((candidate) => candidate.tokenKind === "azureManagement");
  const genericGraph = selectBestCandidate(graphCandidates, (candidate) => getGraphTokenOverallScore(candidate.decoded));
  const directoryGraph = selectTargetGraphCandidate(graphCandidates, "directoryRole");
  const pimGroupGraph = selectTargetGraphCandidate(graphCandidates, "pimGroup");
  const azure = selectBestCandidate(azureCandidates, () => 1);
  const selected = dedupeCandidates([genericGraph, directoryGraph, pimGroupGraph, azure]);
  const coverage = Number(Boolean(genericGraph))
    + Number(Boolean(directoryGraph))
    + Number(Boolean(pimGroupGraph))
    + Number(Boolean(azure));
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
    latestExpiry: Math.max(0, ...selected.map((candidate) => Number(candidate.decoded.exp) || 0))
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
    || left.index - right.index
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
    || right.quality - left.quality
    || right.latestExpiry - left.latestExpiry
    || left.identity.localeCompare(right.identity);
}

function getCandidateIdentity(decoded: Record<string, unknown>): string | undefined {
  return typeof decoded.tid === "string" && typeof decoded.oid === "string"
    ? `${decoded.tid.toLowerCase()}:${decoded.oid.toLowerCase()}`
    : undefined;
}
