import { describe, expect, it } from 'vitest'
import {
  ALGORITHM_FOR_TASK,
  DEFAULT_HYPERPARAMETERS,
  hyperparametersSchema,
  modelDefinitionSchema,
  optimizersForAlgorithm,
  relevantHyperparameters,
} from './model'

const base = {
  name: 'm',
  dataset_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  task: 'regression' as const,
  algorithm: 'linear_regression' as const,
  target_column: 'price',
  feature_columns: ['sqft', 'beds'],
  hyperparameters: DEFAULT_HYPERPARAMETERS.ols,
}

describe('model config', () => {
  it('defaults validate for every optimizer', () => {
    for (const hp of Object.values(DEFAULT_HYPERPARAMETERS)) {
      expect(hyperparametersSchema.safeParse(hp).success).toBe(true)
    }
  })
  it('accepts a valid definition', () => {
    expect(modelDefinitionSchema.safeParse(base).success).toBe(true)
  })
  it('rejects task/algorithm mismatch', () => {
    const r = modelDefinitionSchema.safeParse({ ...base, algorithm: 'logistic_regression' })
    expect(r.success).toBe(false)
  })
  it('rejects target in features and duplicates', () => {
    expect(modelDefinitionSchema.safeParse({ ...base, feature_columns: ['sqft', 'price'] }).success).toBe(false)
    expect(modelDefinitionSchema.safeParse({ ...base, feature_columns: ['sqft', 'sqft'] }).success).toBe(false)
  })
  it('rejects OLS for logistic regression', () => {
    const r = modelDefinitionSchema.safeParse({
      ...base,
      task: 'binary_classification',
      algorithm: ALGORITHM_FOR_TASK.binary_classification,
    })
    expect(r.success).toBe(false)
    expect(optimizersForAlgorithm('logistic_regression')).not.toContain('ols')
    expect(optimizersForAlgorithm('linear_regression')).toContain('ols')
  })
  it('rejects out-of-range hyperparameters', () => {
    expect(hyperparametersSchema.safeParse({ ...DEFAULT_HYPERPARAMETERS.sgd, learning_rate: 0 }).success).toBe(false)
    expect(hyperparametersSchema.safeParse({ ...DEFAULT_HYPERPARAMETERS.sgd, epochs: 1.5 }).success).toBe(false)
    expect(hyperparametersSchema.safeParse({ ...DEFAULT_HYPERPARAMETERS.sgd, l2: -1 }).success).toBe(false)
  })
  it('lists relevant hyperparameters per optimizer', () => {
    expect(relevantHyperparameters('ols')).toEqual(['l2'])
    expect(relevantHyperparameters('adam')).toContain('batch_size')
    expect(relevantHyperparameters('batch_gd')).not.toContain('batch_size')
  })
})
