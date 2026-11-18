/**
 * Explainable lead score: three bounded components that add up to 0-100.
 * Phase 2 will feed AI-extracted signals into the same structure.
 */
export const SCORE_WEIGHTS = Object.freeze({
  urgency: 35,
  budgetFit: 35,
  conversionLikelihood: 30,
});

export function totalFromBreakdown({ urgency, budgetFit, conversionLikelihood }) {
  return urgency + budgetFit + conversionLikelihood;
}
