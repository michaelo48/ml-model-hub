/** A dense row-major matrix: rows[i][j] is sample i, feature j. */
export type Matrix = number[][]
export type Vector = number[]

/** Per-feature statistics used to z-score inputs at train and predict time. */
export interface FeatureStats {
  mean: number[]
  std: number[]
}

/**
 * A trained linear model. `weights` are learned in normalized feature space;
 * `bias` is the intercept. Predict must apply the same `stats` normalization
 * that training used, which is why they travel together in the artifact.
 */
export interface LinearModel {
  weights: number[]
  bias: number
  stats: FeatureStats
}
