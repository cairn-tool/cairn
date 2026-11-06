import { FunctionUnsupported, parseFunction } from "./functions.js";
import type { PdfFunction } from "./functions.js";
import type { ObjectStore } from "./store.js";
import { isDict, isName, isStream, isString } from "./syntax.js";
import type { PdfDict, PdfObject } from "./syntax.js";

/**
 * Image colour spaces, resolved to something a PNG can hold.
 *
 * Grey and RGB samples (device, calibrated, or ICC-based with 1 or 3
 * components) are carried over verbatim — no colour management is applied, so
 * the PNG holds the document's own sample values. Everything else (CMYK, Lab,
 * Separation, DeviceN) is converted to RGB by formula, which is an
 * approximation and is reported as one.
 */
export interface ColorSpace {
  /** What the index reports: `DeviceRGB`, `ICCBased(3)`, `Indexed(DeviceRGB,255)`, … */
  label: string;
  /** Components per sample. */
  components: number;
  /** The PNG colour model these samples become. */
  output: "gray" | "rgb";
  /** False when the conversion to `output` is a formula rather than a copy. */
  verbatim: boolean;
  /** Converts decoded component values (each 0..1, or an index for Indexed) to 8-bit output. */
  convert(components: number[], out: Uint8Array, at: number): void;
  /** Present for an Indexed space, so a palette PNG can be written directly. */
  indexed?: { base: ColorSpace; hival: number; lookup: Uint8Array };
}

export class ColorSpaceUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ColorSpaceUnsupported";
  }
}

const byte = (value: number): number => Math.max(0, Math.min(255, Math.round(value * 255)));

export const DEVICE_GRAY: ColorSpace = {
  label: "DeviceGray",
  components: 1,
  output: "gray",
  verbatim: true,
  convert: (c, out, at) => {
    out[at] = byte(c[0]);
  },
};

export const DEVICE_RGB: ColorSpace = {
  label: "DeviceRGB",
  components: 3,
  output: "rgb",
  verbatim: true,
  convert: (c, out, at) => {
    out[at] = byte(c[0]);
    out[at + 1] = byte(c[1]);
    out[at + 2] = byte(c[2]);
  },
};

export const DEVICE_CMYK: ColorSpace = {
  label: "DeviceCMYK",
  components: 4,
  output: "rgb",
  verbatim: false,
  convert: (c, out, at) => {
    const k = 1 - c[3];
    out[at] = byte((1 - c[0]) * k);
    out[at + 1] = byte((1 - c[1]) * k);
    out[at + 2] = byte((1 - c[2]) * k);
  },
};

function relabel(space: ColorSpace, label: string): ColorSpace {
  return { ...space, label };
}

function deviceFor(components: number): ColorSpace {
  if (components === 1) return DEVICE_GRAY;
  if (components === 3) return DEVICE_RGB;
  if (components === 4) return DEVICE_CMYK;
  throw new ColorSpaceUnsupported(`An ICC profile with ${components} components is not supported`);
}

function lab(store: ObjectStore, dict: PdfDict | null): ColorSpace {
  const white = store.lookup(dict, "WhitePoint");
  const [xw, yw, zw] = Array.isArray(white)
    ? white.map((value) => (typeof value === "number" ? value : 1))
    : [0.9505, 1, 1.089];
  const rangeValue = store.lookup(dict, "Range");
  const range = Array.isArray(rangeValue)
    ? rangeValue.map((value) => (typeof value === "number" ? value : 0))
    : [-100, 100, -100, 100];
  const g = (x: number): number => (x >= 6 / 29 ? x * x * x : (108 / 841) * (x - 4 / 29));
  const gamma = (v: number): number =>
    v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return {
    label: "Lab",
    components: 3,
    output: "rgb",
    verbatim: false,
    convert: (c, out, at) => {
      // Decoded values arrive as 0..1; Lab's own ranges are restored first.
      const l = c[0] * 100;
      const a = range[0] + c[1] * (range[1] - range[0]);
      const b = range[2] + c[2] * (range[3] - range[2]);
      const m = (l + 16) / 116;
      const x = xw * g(m + a / 500);
      const y = yw * g(m);
      const z = zw * g(m - b / 200);
      const r = 3.2406 * x - 1.5372 * y - 0.4986 * z;
      const gg = -0.9689 * x + 1.8758 * y + 0.0415 * z;
      const bb = 0.0557 * x - 0.204 * y + 1.057 * z;
      out[at] = byte(gamma(Math.max(0, r)));
      out[at + 1] = byte(gamma(Math.max(0, gg)));
      out[at + 2] = byte(gamma(Math.max(0, bb)));
    },
  };
}

function tinted(
  label: string,
  components: number,
  alternate: ColorSpace,
  transform: PdfFunction,
): ColorSpace {
  const scratch = new Uint8Array(3);
  return {
    label,
    components,
    output: alternate.output,
    verbatim: false,
    convert: (c, out, at) => {
      const converted = transform(c.slice(0, components));
      alternate.convert(converted, scratch, 0);
      out[at] = scratch[0];
      if (alternate.output === "rgb") {
        out[at + 1] = scratch[1];
        out[at + 2] = scratch[2];
      }
    },
  };
}

const MAX_DEPTH = 8;

/**
 * Resolves a colour space value — a name, a resource name, or an array.
 *
 * `resources` is the `/ColorSpace` resource dictionary in scope, which is how a
 * named space such as `/CS0` resolves.
 */
export function resolveColorSpace(
  store: ObjectStore,
  value: PdfObject,
  resources: PdfDict | null,
  depth = 0,
): ColorSpace {
  if (depth > MAX_DEPTH) throw new ColorSpaceUnsupported("Colour space nesting is too deep");
  const resolved = store.resolve(value);
  if (isName(resolved)) {
    switch (resolved.name) {
      case "DeviceGray":
      case "G":
      case "CalGray":
        return DEVICE_GRAY;
      case "DeviceRGB":
      case "RGB":
      case "CalRGB":
        return DEVICE_RGB;
      case "DeviceCMYK":
      case "CMYK":
        return DEVICE_CMYK;
      case "Pattern":
        throw new ColorSpaceUnsupported("A Pattern colour space cannot colour an image");
      default: {
        const named = store.dictAt(resources, "ColorSpace");
        const entry = named ? named.map.get(resolved.name) : undefined;
        if (entry === undefined)
          throw new ColorSpaceUnsupported(`The colour space /${resolved.name} is not defined`);
        return resolveColorSpace(store, entry, resources, depth + 1);
      }
    }
  }
  if (!Array.isArray(resolved) || !resolved.length)
    throw new ColorSpaceUnsupported("The colour space is neither a name nor an array");

  const family = store.resolve(resolved[0]);
  const familyName = isName(family) ? family.name : "";
  switch (familyName) {
    case "DeviceGray":
    case "DeviceRGB":
    case "DeviceCMYK":
      return resolveColorSpace(store, family, resources, depth + 1);
    case "CalGray":
      return relabel(DEVICE_GRAY, "CalGray");
    case "CalRGB":
      return relabel(DEVICE_RGB, "CalRGB");
    case "Lab": {
      const dict = store.resolve(resolved[1]);
      return lab(store, isDict(dict) ? dict : null);
    }
    case "ICCBased": {
      const stream = store.resolve(resolved[1]);
      const dict = isStream(stream) ? stream.dict : isDict(stream) ? stream : null;
      const n = Number(store.lookup(dict, "N")) || 0;
      const alternate = store.lookup(dict, "Alternate");
      let base: ColorSpace;
      if (n === 1 || n === 3 || n === 4) base = deviceFor(n);
      else if (alternate !== null) base = resolveColorSpace(store, alternate, resources, depth + 1);
      else throw new ColorSpaceUnsupported(`An ICC profile with ${n} components is not supported`);
      return relabel(base, `ICCBased(${base.components})`);
    }
    case "Indexed":
    case "I": {
      const base = resolveColorSpace(store, resolved[1] ?? null, resources, depth + 1);
      const hival = Math.max(0, Math.min(255, Math.trunc(Number(store.resolve(resolved[2])) || 0)));
      const lookupValue = store.resolve(resolved[3]);
      const lookup = isString(lookupValue)
        ? lookupValue.bytes
        : isStream(lookupValue)
          ? store.streamData(lookupValue)
          : new Uint8Array(0);
      const scratch = new Array<number>(base.components).fill(0);
      return {
        label: `Indexed(${base.label},${hival})`,
        components: 1,
        output: base.output,
        verbatim: base.verbatim,
        indexed: { base, hival, lookup },
        convert: (c, out, at) => {
          const index = Math.max(0, Math.min(hival, Math.round(c[0])));
          for (let component = 0; component < base.components; component += 1)
            scratch[component] = (lookup[index * base.components + component] ?? 0) / 255;
          base.convert(scratch, out, at);
        },
      };
    }
    case "Separation": {
      const colorant = store.resolve(resolved[1]);
      const colorantName = isName(colorant) ? colorant.name : "";
      if (colorantName === "None")
        return {
          label: "Separation(None)",
          components: 1,
          output: "gray",
          verbatim: false,
          convert: (_c, out, at) => {
            out[at] = 255;
          },
        };
      const alternate = resolveColorSpace(store, resolved[2] ?? null, resources, depth + 1);
      let transform: PdfFunction;
      try {
        transform = parseFunction(store, resolved[3] ?? null);
      } catch (error) {
        if (error instanceof FunctionUnsupported)
          throw new ColorSpaceUnsupported(`Separation tint transform: ${error.message}`);
        throw error;
      }
      return tinted(`Separation(${colorantName})`, 1, alternate, transform);
    }
    case "DeviceN": {
      const names = store.resolve(resolved[1]);
      const n = Array.isArray(names) ? names.length : 0;
      if (!n) throw new ColorSpaceUnsupported("A DeviceN colour space names no colorants");
      const alternate = resolveColorSpace(store, resolved[2] ?? null, resources, depth + 1);
      let transform: PdfFunction;
      try {
        transform = parseFunction(store, resolved[3] ?? null);
      } catch (error) {
        if (error instanceof FunctionUnsupported)
          throw new ColorSpaceUnsupported(`DeviceN tint transform: ${error.message}`);
        throw error;
      }
      return tinted(`DeviceN(${n})`, n, alternate, transform);
    }
    case "Pattern":
      throw new ColorSpaceUnsupported("A Pattern colour space cannot colour an image");
    default:
      throw new ColorSpaceUnsupported(
        `The colour space family /${familyName || "?"} is not supported`,
      );
  }
}
