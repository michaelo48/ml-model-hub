import type { Vector } from './types'

function assertSameLength(a: Vector, b: Vector, name: string): void {
  if (a.length !== b.length) throw new Error(`${name}: length mismatch`)
  if (a.length === 0) throw new Error(`${name}: empty input`)
}

export function mse(yTrue: Vector, yPred: Vector): number {
  assertSameLength(yTrue, yPred, 'mse')
  let s = 0
  for (let i = 0; i < yTrue.length; i++) {
    const d = yTrue[i]! - yPred[i]!
    s += d * d
  }
  return s / yTrue.length
}

export function rmse(yTrue: Vector, yPred: Vector): number {
  return Math.sqrt(mse(yTrue, yPred))
}

/** Coefficient of determination. 1 = perfect, 0 = predicting the mean. */
export function r2(yTrue: Vector, yPred: Vector): number {
  assertSameLength(yTrue, yPred, 'r2')
  const mean = yTrue.reduce((a, b) => a + b, 0) / yTrue.length
  let ssRes = 0
  let ssTot = 0
  for (let i = 0; i < yTrue.length; i++) {
    ssRes += (yTrue[i]! - yPred[i]!) ** 2
    ssTot += (yTrue[i]! - mean) ** 2
  }
  if (ssTot === 0) return ssRes === 0 ? 1 : 0
  return 1 - ssRes / ssTot
}
