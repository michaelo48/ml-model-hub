import { z } from 'zod'

/**
 * Model configuration shared by the web app (form validation, model builder)
 * and the worker (training). Kept in packages/ml so both sides agree on
 * names, ranges and defaults.
 */

export const TASKS = ['regression', 'binary_classification'] as const
export const taskSchema = z.enum(TASKS)
export type Task = z.infer<typeof taskSchema>

export const ALGORITHMS = ['linear_regression', 'logistic_regression'] as const
export const algorithmSchema = z.enum(ALGORITHMS)
export type Algorithm = z.infer<typeof algorithmSchema>

/** v1: one algorithm per task. */
export const ALGORITHM_FOR_TASK: Record<Task, Algorithm> = {
  regression: 'linear_regression',
  binary_classification: 'logistic_regression',
}

export const OPTIMIZERS = ['ols', 'batch_gd', 'sgd', 'adam'] as const
export const optimizerSchema = z.enum(OPTIMIZERS)
export type Optimizer = z.infer<typeof optimizerSchema>

export const OPTIMIZER_LABELS: Record<Optimizer, string> = {
  ols: 'OLS (closed form)',
  batch_gd: 'Batch gradient descent',
  sgd: 'Stochastic gradient descent',
  adam: 'Adam',
}

/** OLS is closed-form least squares; it only applies to linear regression. */
export function optimizersForAlgorithm(algorithm: Algorithm): readonly Optimizer[] {
  return algorithm === 'linear_regression' ? OPTIMIZERS : (['batch_gd', 'sgd', 'adam'] as const)
}

export const HYPERPARAMETER_LIMITS = {
  learningRate: { min: 1e-6, max: 10 },
  epochs: { min: 1, max: 5000 },
  batchSize: { min: 1, max: 100_000 },
  l2: { min: 0, max: 1000 },
} as const

export const hyperparametersSchema = z.object({
  optimizer: optimizerSchema,
  learning_rate: z
    .number()
    .min(HYPERPARAMETER_LIMITS.learningRate.min)
    .max(HYPERPARAMETER_LIMITS.learningRate.max),
  epochs: z.number().int().min(HYPERPARAMETER_LIMITS.epochs.min).max(HYPERPARAMETER_LIMITS.epochs.max),
  batch_size: z.number().int().min(HYPERPARAMETER_LIMITS.batchSize.min).max(HYPERPARAMETER_LIMITS.batchSize.max),
  l2: z.number().min(HYPERPARAMETER_LIMITS.l2.min).max(HYPERPARAMETER_LIMITS.l2.max),
})
export type Hyperparameters = z.infer<typeof hyperparametersSchema>

export const DEFAULT_HYPERPARAMETERS: Record<Optimizer, Hyperparameters> = {
  ols: { optimizer: 'ols', learning_rate: 0.01, epochs: 1, batch_size: 32, l2: 0 },
  batch_gd: { optimizer: 'batch_gd', learning_rate: 0.05, epochs: 200, batch_size: 32, l2: 0 },
  sgd: { optimizer: 'sgd', learning_rate: 0.01, epochs: 50, batch_size: 32, l2: 0 },
  adam: { optimizer: 'adam', learning_rate: 0.01, epochs: 100, batch_size: 32, l2: 0 },
}

/** Which hyperparameters an optimizer actually reads (drives the form). */
export function relevantHyperparameters(optimizer: Optimizer): ReadonlyArray<keyof Hyperparameters> {
  switch (optimizer) {
    case 'ols':
      return ['l2']
    case 'batch_gd':
      return ['learning_rate', 'epochs', 'l2']
    case 'sgd':
    case 'adam':
      return ['learning_rate', 'epochs', 'batch_size', 'l2']
  }
}

/** Full model definition as validated by the web app before insert. */
export const modelDefinitionSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required.').max(120, 'Name is too long.'),
    dataset_id: z.string().uuid(),
    task: taskSchema,
    algorithm: algorithmSchema,
    target_column: z.string().min(1, 'Pick a target column.'),
    feature_columns: z.array(z.string().min(1)).min(1, 'Pick at least one feature.').max(500),
    hyperparameters: hyperparametersSchema,
  })
  .superRefine((m, ctx) => {
    if (ALGORITHM_FOR_TASK[m.task] !== m.algorithm) {
      ctx.addIssue({ code: 'custom', path: ['algorithm'], message: 'Algorithm does not match task.' })
    }
    if (m.feature_columns.includes(m.target_column)) {
      ctx.addIssue({ code: 'custom', path: ['feature_columns'], message: 'Target cannot also be a feature.' })
    }
    if (new Set(m.feature_columns).size !== m.feature_columns.length) {
      ctx.addIssue({ code: 'custom', path: ['feature_columns'], message: 'Duplicate feature columns.' })
    }
    if (!optimizersForAlgorithm(m.algorithm).includes(m.hyperparameters.optimizer)) {
      ctx.addIssue({
        code: 'custom',
        path: ['hyperparameters', 'optimizer'],
        message: 'That optimizer is not available for this algorithm.',
      })
    }
  })
export type ModelDefinition = z.infer<typeof modelDefinitionSchema>
