export type { FeatureStats, LinearModel, Matrix, Vector } from './types'
export { computeStats, applyStats } from './normalize'
export { solve, gram, gramVec } from './linalg'
export { fitOls, predictLinear, type OlsOptions } from './linear/ols'
export { fitLinearGd } from './linear/gd'
export { fitLogistic, predictProba, predictClass } from './logistic/logistic'
export {
  trainGradient,
  sigmoid,
  type EpochMetrics,
  type GradientOptimizer,
  type GradientTrainOptions,
  type Link,
} from './optim/gradient'
export { fitModel, type FitOptions } from './train'
export { createRng, shuffledIndices } from './random'
export { mse, rmse, r2, logLoss, accuracy } from './metrics'
export * from './config/model'
export {
  ARTIFACT_FORMAT,
  artifactSchema,
  artifactMetricsSchema,
  buildArtifact,
  parseArtifact,
  predictWithArtifact,
  type Artifact,
  type ArtifactMetrics,
  type BuildArtifactInput,
} from './artifact'
export { DivergenceError, SingularMatrixError } from './errors'
