/**
 * Typed training failures. Callers (the worker) distinguish these from
 * programming errors by `instanceof`, never by matching message text.
 */

/** The loss became non-finite during gradient descent; the learning rate is too high for this data. */
export class DivergenceError extends Error {
  override readonly name = 'DivergenceError'
  constructor(
    readonly epoch: number,
    readonly learningRate: number
  ) {
    super(`loss diverged at epoch ${epoch} (learning rate ${learningRate} is too high for this data)`)
  }
}

/** The normal-equations system has no unique solution: features are collinear. */
export class SingularMatrixError extends Error {
  override readonly name = 'SingularMatrixError'
  constructor() {
    super('matrix is singular or ill-conditioned')
  }
}
