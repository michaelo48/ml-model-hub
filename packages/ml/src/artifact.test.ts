import { describe, expect, it } from 'vitest'
import { buildArtifact, parseArtifact, predictWithArtifact } from './artifact'
import { DEFAULT_HYPERPARAMETERS } from './config/model'
import { fitOls, predictLinear } from './linear/ols'
import { fitLogistic, predictProba } from './logistic/logistic'

const X = [
  [1, 10],
  [2, 30],
  [3, 20],
  [4, 50],
  [5, 40],
]
const y = X.map(([a, b]) => 2 * a! + 0.5 * b! + 1)

describe('artifact', () => {
  it('round-trips through JSON and predicts identically to the model', () => {
    const model = fitOls(X, y)
    const artifact = buildArtifact({
      task: 'regression',
      algorithm: 'linear_regression',
      target_column: 'y',
      feature_columns: ['a', 'b'],
      hyperparameters: DEFAULT_HYPERPARAMETERS.ols,
      model,
      metrics: { train_loss: 0, rmse: 0, r2: 1, n_rows: 5, epochs_run: 1 },
      trained_at: new Date('2026-01-01T00:00:00Z'),
    })
    const back = parseArtifact(JSON.parse(JSON.stringify(artifact)))
    expect(back).toEqual(artifact)
    expect(predictWithArtifact(back, X)).toEqual(predictLinear(model, X))
  })

  it('applies the sigmoid link for logistic artifacts', () => {
    const yb = X.map(([a]) => (a! > 2.5 ? 1 : 0))
    const model = fitLogistic(X, yb, { ...DEFAULT_HYPERPARAMETERS.adam, optimizer: 'adam', epochs: 50 })
    const artifact = buildArtifact({
      task: 'binary_classification',
      algorithm: 'logistic_regression',
      target_column: 'y',
      feature_columns: ['a', 'b'],
      hyperparameters: DEFAULT_HYPERPARAMETERS.adam,
      model,
      metrics: { train_loss: 0.1, accuracy: 1, n_rows: 5, epochs_run: 50 },
      trained_at: new Date(),
    })
    const p = predictWithArtifact(artifact, X)
    expect(p).toEqual(predictProba(model, X))
    expect(p.every((v) => v >= 0 && v <= 1)).toBe(true)
  })

  it('rejects a weight/feature length mismatch', () => {
    const model = fitOls(X, y)
    expect(() =>
      buildArtifact({
        task: 'regression',
        algorithm: 'linear_regression',
        target_column: 'y',
        feature_columns: ['a'],
        hyperparameters: DEFAULT_HYPERPARAMETERS.ols,
        model,
        metrics: { train_loss: 0, n_rows: 5, epochs_run: 1 },
        trained_at: new Date(),
      })
    ).toThrow(/weights/)
  })

  it('rejects unknown formats', () => {
    expect(() => parseArtifact({ format: 'something.else' })).toThrow()
  })
})
