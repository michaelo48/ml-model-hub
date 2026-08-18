import type { Matrix, Vector } from './types'

/**
 * Solve A x = b for square A using Gaussian elimination with partial pivoting.
 * Mutates copies, not the inputs. Throws if A is singular (to tolerance).
 */
export function solve(A: Matrix, b: Vector): Vector {
  const n = A.length
  if (n === 0 || A.some((r) => r.length !== n) || b.length !== n) {
    throw new Error('solve: A must be square and b must match its size')
  }

  // Augmented matrix [A | b]
  const M: Matrix = A.map((row, i) => [...row, b[i]!])

  for (let col = 0; col < n; col++) {
    // Partial pivot: pick the row with the largest |value| in this column.
    let pivot = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r
    }
    if (Math.abs(M[pivot]![col]!) < 1e-12) {
      throw new Error('solve: matrix is singular or ill-conditioned')
    }
    if (pivot !== col) {
      const tmp = M[col]!
      M[col] = M[pivot]!
      M[pivot] = tmp
    }

    // Eliminate below.
    const p = M[col]!
    for (let r = col + 1; r < n; r++) {
      const row = M[r]!
      const factor = row[col]! / p[col]!
      if (factor === 0) continue
      for (let c = col; c <= n; c++) row[c]! -= factor * p[c]!
    }
  }

  // Back-substitution.
  const x = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    const row = M[i]!
    let sum = row[n]!
    for (let c = i + 1; c < n; c++) sum -= row[c]! * x[c]!
    x[i] = sum / row[i]!
  }
  return x
}

/** Xᵀ X for row-major X. */
export function gram(X: Matrix): Matrix {
  const d = X[0]?.length ?? 0
  const G: Matrix = Array.from({ length: d }, () => new Array<number>(d).fill(0))
  for (const row of X) {
    for (let i = 0; i < d; i++) {
      const xi = row[i]!
      if (xi === 0) continue
      const Gi = G[i]!
      for (let j = i; j < d; j++) Gi[j]! += xi * row[j]!
    }
  }
  // Mirror the upper triangle.
  for (let i = 0; i < d; i++) for (let j = 0; j < i; j++) G[i]![j] = G[j]![i]!
  return G
}

/** Xᵀ y for row-major X. */
export function gramVec(X: Matrix, y: Vector): Vector {
  const d = X[0]?.length ?? 0
  const v = new Array<number>(d).fill(0)
  X.forEach((row, r) => {
    const yr = y[r]!
    for (let j = 0; j < d; j++) v[j]! += row[j]! * yr
  })
  return v
}
