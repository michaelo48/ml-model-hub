import { z } from 'zod'
import { algorithmSchema, hyperparametersSchema, taskSchema, type Algorithm } from './config/model'
import { predictLinear } from './linear/ols'
import { predictProba } from './logistic/logistic'
import type { LinearModel, Matrix, Vector } from './types'

/**
 * The trained-model artifact. The worker writes one JSON file per model
 * version to storage; the inference route reads it back. Everything needed to
 * reproduce a prediction travels together: weights, the normalization stats
 * they were learned under, and the feature order the weights correspond to.
 *
 * `format` is a version tag so a future shape change can be read side by side
 * with old artifacts instead of silently mis-predicting.
 */
export const ARTIFACT_FORMAT = 'modelforge.linear.v1' as const

export const artifactMetricsSchema = z.object({
  /** Final training loss: MSE for regression, log-loss for classification. */
  train_loss: z.number(),
  rmse: z.number().optional(),
  r2: z.number().optional(),
  accuracy: z.number().optional(),
  n_rows: z.number().int().nonnegative(),
  epochs_run: z.number().int().nonnegative(),
})
export type ArtifactMetrics = z.infer<typeof artifactMetricsSchema>

export const artifactSchema = z.object({
  format: z.literal(ARTIFACT_FORMAT),
  task: taskSchema,
  algorithm: algorithmSchema,
  target_column: z.string().min(1),
  feature_columns: z.array(z.string().min(1)).min(1),
  hyperparameters: hyperparametersSchema,
  weights: z.array(z.number()),
  bias: z.number(),
  stats: z.object({ mean: z.array(z.number()), std: z.array(z.number()) }),
  metrics: artifactMetricsSchema,
  /** ISO 8601 timestamp of when training finished. */
  trained_at: z.string().datetime(),
})
export type Artifact = z.infer<typeof artifactSchema>

export interface BuildArtifactInput {
  task: Artifact['task']
  algorithm: Algorithm
  target_column: string
  feature_columns: string[]
  hyperparameters: Artifact['hyperparameters']
  model: LinearModel
  metrics: ArtifactMetrics
  trained_at: Date
}

/** Assemble and validate an artifact from a fitted model. Throws on a shape mismatch. */
export function buildArtifact(input: BuildArtifactInput): Artifact {
  const { model } = input
  if (model.weights.length !== input.feature_columns.length) {
    throw new Error(
      `buildArtifact: ${model.weights.length} weights for ${input.feature_columns.length} feature columns`
    )
  }
  return artifactSchema.parse({
    format: ARTIFACT_FORMAT,
    task: input.task,
    algorithm: input.algorithm,
    target_column: input.target_column,
    feature_columns: input.feature_columns,
    hyperparameters: input.hyperparameters,
    weights: model.weights,
    bias: model.bias,
    stats: model.stats,
    metrics: input.metrics,
    trained_at: input.trained_at.toISOString(),
  })
}

/** Parse an artifact read back from storage. Throws a descriptive error on mismatch. */
export function parseArtifact(json: unknown): Artifact {
  return artifactSchema.parse(json)
}

/**
 * Predict for raw feature rows ordered as artifact.feature_columns.
 * Regression returns the linear output; classification returns P(y = 1).
 */
export function predictWithArtifact(artifact: Artifact, X: Matrix): Vector {
  const model: LinearModel = { weights: artifact.weights, bias: artifact.bias, stats: artifact.stats }
  return artifact.algorithm === 'logistic_regression' ? predictProba(model, X) : predictLinear(model, X)
}
