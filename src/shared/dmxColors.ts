import { Normalized } from '../math/util'
import { Params } from './params'

export type Color = 'red' | 'green' | 'blue' | 'white' | 'black'

type RGB = [number, number, number]

export const colorList = ['red', 'green', 'blue', 'white', 'black']

export type Colors = { [key in Color]: Normalized }

function intermediate(C: number, X: number, hp: Normalized) {
  if (hp < 1) {
    return [C, X, 0]
  } else if (hp < 2) {
    return [X, C, 0]
  } else if (hp < 3) {
    return [0, C, X]
  } else if (hp < 4) {
    return [0, X, C]
  } else if (hp < 5) {
    return [X, 0, C]
  } else {
    return [C, 0, X]
  }
}

// https://en.wikipedia.org/wiki/HSL_and_HSV
export function hsl2rgb(h: Normalized, s: Normalized, l: Normalized): RGB {
  const hp = h * 6
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] = intermediate(c, x, hp)
  const m = l - c / 2
  return [r1 + m, g1 + m, b1 + m]
}

export function hsv2rgb(h: Normalized, s: Normalized, v: Normalized): RGB {
  const hp = h * 6
  const c = v * s
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] = intermediate(c, x, hp)
  const m = v - c
  return [r1 + m, g1 + m, b1 + m]
}

export function hsi2rgb(h: Normalized, s: Normalized, i: Normalized): RGB {
  const hp = h * 6
  const z = 1 - Math.abs((hp % 2) - 1)
  const c = (3 * i * s) / (1 + z)
  const x = c * z
  const [r1, g1, b1] = intermediate(c, x, hp)
  const m = i * (1 - s)
  return [r1 + m, g1 + m, b1 + m]
}

export function getColors(params: Params): Colors {
  const [r, g, b] = hsv2rgb(params.hue ?? 0, params.saturation ?? 0, 1.0)

  return {
    red: r,
    green: g,
    blue: b,
    black: params.black ?? 0,
    // The min of r g b represents a little bit of white
    white: Math.min(r, g, b),
  }
}
