import type { ObjectStore } from "./store.js";
import { Lexer, isDict, isStream } from "./syntax.js";
import type { PdfObject } from "./syntax.js";

/**
 * PDF functions (types 0, 2, 3, and 4), for the tint transforms of Separation
 * and DeviceN colour spaces.
 *
 * A type 4 function is a PostScript calculator program. It is *interpreted*
 * here, by a fixed operator table over a bounded stack — never compiled to
 * JavaScript, which is what pdf.js does when `isEvalSupported` is on. A
 * document's program decides arithmetic, nothing else.
 */

export type PdfFunction = (input: number[]) => number[];

export class FunctionUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FunctionUnsupported";
  }
}

const numbers = (value: PdfObject): number[] =>
  Array.isArray(value) ? value.map((item) => (typeof item === "number" ? item : 0)) : [];

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/** Steps a type 4 program may execute per call, so a loop-free but enormous program is still bounded. */
const MAX_PS_STEPS = 10_000;
const MAX_PS_STACK = 100;

export function parseFunction(store: ObjectStore, value: PdfObject, depth = 0): PdfFunction {
  if (depth > 8) throw new FunctionUnsupported("Function nesting is too deep");
  const resolved = store.resolve(value);
  if (Array.isArray(resolved)) {
    // An array of 1-output functions, one per output component.
    const parts = resolved.map((item) => parseFunction(store, item, depth + 1));
    return (input) => parts.map((part) => part(input)[0] ?? 0);
  }
  const dict = isStream(resolved) ? resolved.dict : isDict(resolved) ? resolved : null;
  if (!dict) throw new FunctionUnsupported("A function is neither a dictionary nor a stream");
  const type = store.lookup(dict, "FunctionType");
  const domain = numbers(store.lookup(dict, "Domain"));
  const range = numbers(store.lookup(dict, "Range"));
  const clipIn = (input: number[]): number[] =>
    input.map((item, index) =>
      domain.length > index * 2 + 1 ? clamp(item, domain[index * 2], domain[index * 2 + 1]) : item,
    );
  const clipOut = (output: number[]): number[] =>
    range.length
      ? output.map((item, index) =>
          range.length > index * 2 + 1 ? clamp(item, range[index * 2], range[index * 2 + 1]) : item,
        )
      : output;

  switch (type) {
    case 2: {
      const c0 = numbers(store.lookup(dict, "C0"));
      const c1 = numbers(store.lookup(dict, "C1"));
      const exponent = Number(store.lookup(dict, "N")) || 1;
      const zero = c0.length ? c0 : [0];
      const one = c1.length ? c1 : [1];
      return (input) => {
        const x = clipIn(input)[0] ?? 0;
        const power = Math.pow(x, exponent);
        return clipOut(zero.map((start, index) => start + power * ((one[index] ?? 1) - start)));
      };
    }
    case 3: {
      const functions = store.lookup(dict, "Functions");
      const parts = Array.isArray(functions)
        ? functions.map((item) => parseFunction(store, item, depth + 1))
        : [];
      const bounds = numbers(store.lookup(dict, "Bounds"));
      const encode = numbers(store.lookup(dict, "Encode"));
      return (input) => {
        const x = clipIn(input)[0] ?? 0;
        let index = 0;
        while (index < bounds.length && x >= bounds[index]) index += 1;
        const low = index === 0 ? domain[0] : bounds[index - 1];
        const high = index === bounds.length ? domain[1] : bounds[index];
        const e0 = encode[index * 2] ?? 0;
        const e1 = encode[index * 2 + 1] ?? 1;
        const mapped = high === low ? e0 : e0 + ((x - low) * (e1 - e0)) / (high - low);
        const part = parts[index];
        return clipOut(part ? part([mapped]) : [0]);
      };
    }
    case 0: {
      if (!isStream(resolved)) throw new FunctionUnsupported("A sampled function is not a stream");
      const size = numbers(store.lookup(dict, "Size"));
      const bps = Number(store.lookup(dict, "BitsPerSample")) || 8;
      const encode = numbers(store.lookup(dict, "Encode"));
      const decode = numbers(store.lookup(dict, "Decode"));
      const samples = store.streamData(resolved);
      const outputs = range.length / 2;
      if (!size.length || !outputs) throw new FunctionUnsupported("A sampled function has no Size");
      const max = Math.pow(2, bps) - 1;
      const sampleAt = (position: number): number => {
        const bit = position * bps;
        if (bps === 8) return samples[position] ?? 0;
        if (bps === 16)
          return ((samples[position * 2] ?? 0) << 8) | (samples[position * 2 + 1] ?? 0);
        let value = 0;
        for (let offset = 0; offset < bps; offset += 1) {
          const index = bit + offset;
          value = (value << 1) | (((samples[index >> 3] ?? 0) >> (7 - (index & 7))) & 1);
        }
        return value;
      };
      return (input) => {
        const clipped = clipIn(input);
        // Nearest sample: interpolation is not needed to colour an image's pixels faithfully enough.
        let position = 0;
        let stride = 1;
        clipped.forEach((x, dimension) => {
          const d0 = domain[dimension * 2] ?? 0;
          const d1 = domain[dimension * 2 + 1] ?? 1;
          const e0 = encode[dimension * 2] ?? 0;
          const e1 = encode[dimension * 2 + 1] ?? (size[dimension] ?? 1) - 1;
          const e = d1 === d0 ? e0 : e0 + ((x - d0) * (e1 - e0)) / (d1 - d0);
          const index = clamp(Math.round(e), 0, (size[dimension] ?? 1) - 1);
          position += index * stride;
          stride *= size[dimension] ?? 1;
        });
        const out: number[] = [];
        for (let output = 0; output < outputs; output += 1) {
          const raw = sampleAt(position * outputs + output);
          const r0 = decode[output * 2] ?? range[output * 2];
          const r1 = decode[output * 2 + 1] ?? range[output * 2 + 1];
          out.push(r0 + (raw / max) * (r1 - r0));
        }
        return clipOut(out);
      };
    }
    case 4: {
      if (!isStream(resolved))
        throw new FunctionUnsupported("A PostScript function is not a stream");
      const program = parsePostScript(store.streamData(resolved));
      return (input) => {
        const stack = runPostScript(program, clipIn(input));
        const outputs = range.length / 2;
        return clipOut(stack.slice(Math.max(0, stack.length - outputs)));
      };
    }
    default:
      throw new FunctionUnsupported(`Function type ${String(type)} is not supported`);
  }
}

type PsNode = number | boolean | string | { ifTrue: PsNode[]; ifFalse?: PsNode[] };

function parsePostScript(source: Uint8Array): PsNode[] {
  const lexer = new Lexer(source);
  const parseBlock = (depth: number): PsNode[] => {
    if (depth > 32) throw new FunctionUnsupported("PostScript nesting is too deep");
    const nodes: PsNode[] = [];
    for (;;) {
      const token = lexer.next();
      if (token.type === "eof") return nodes;
      if (token.type === "punct" && token.value === "}") return nodes;
      if (token.type === "punct" && token.value === "{") {
        const block = parseBlock(depth + 1);
        // Peek at the operator that consumes the block(s).
        const saved = lexer.pos;
        const next = lexer.next();
        if (next.type === "punct" && next.value === "{") {
          const second = parseBlock(depth + 1);
          const op = lexer.next();
          if (op.type === "keyword" && op.value === "ifelse")
            nodes.push({ ifTrue: block, ifFalse: second });
          continue;
        }
        if (next.type === "keyword" && next.value === "if") {
          nodes.push({ ifTrue: block });
          continue;
        }
        lexer.pos = saved;
        // A bare block (the outer program braces): splice it in.
        nodes.push(...block);
        continue;
      }
      if (token.type === "number") nodes.push(token.value);
      else if (token.type === "keyword") {
        if (token.value === "true") nodes.push(true);
        else if (token.value === "false") nodes.push(false);
        else nodes.push(token.value);
      }
    }
  };
  return parseBlock(0);
}

function runPostScript(program: PsNode[], input: number[]): number[] {
  const stack: (number | boolean)[] = [...input];
  let steps = 0;
  const pop = (): number => {
    const value = stack.pop();
    return typeof value === "number" ? value : value ? 1 : 0;
  };
  const popBool = (): boolean => {
    const value = stack.pop();
    return typeof value === "boolean" ? value : Boolean(value);
  };
  const push = (value: number | boolean): void => {
    if (stack.length >= MAX_PS_STACK) throw new FunctionUnsupported("PostScript stack overflow");
    stack.push(value);
  };
  const execute = (nodes: PsNode[]): void => {
    for (const node of nodes) {
      steps += 1;
      if (steps > MAX_PS_STEPS) throw new FunctionUnsupported("PostScript program too long");
      if (typeof node === "number" || typeof node === "boolean") {
        push(node);
        continue;
      }
      if (typeof node === "object") {
        if (popBool()) execute(node.ifTrue);
        else if (node.ifFalse) execute(node.ifFalse);
        continue;
      }
      switch (node) {
        case "add": {
          const b = pop();
          push(pop() + b);
          break;
        }
        case "sub": {
          const b = pop();
          push(pop() - b);
          break;
        }
        case "mul": {
          const b = pop();
          push(pop() * b);
          break;
        }
        case "div": {
          const b = pop();
          const a = pop();
          push(b === 0 ? 0 : a / b);
          break;
        }
        case "idiv": {
          const b = pop();
          const a = pop();
          push(b === 0 ? 0 : Math.trunc(a / b));
          break;
        }
        case "mod": {
          const b = pop();
          const a = pop();
          push(b === 0 ? 0 : a % b);
          break;
        }
        case "neg":
          push(-pop());
          break;
        case "abs":
          push(Math.abs(pop()));
          break;
        case "ceiling":
          push(Math.ceil(pop()));
          break;
        case "floor":
          push(Math.floor(pop()));
          break;
        case "round":
          push(Math.round(pop()));
          break;
        case "truncate":
          push(Math.trunc(pop()));
          break;
        case "sqrt":
          push(Math.sqrt(Math.max(0, pop())));
          break;
        case "sin":
          push(Math.sin((pop() * Math.PI) / 180));
          break;
        case "cos":
          push(Math.cos((pop() * Math.PI) / 180));
          break;
        case "atan": {
          const b = pop();
          const a = pop();
          let angle = (Math.atan2(a, b) * 180) / Math.PI;
          if (angle < 0) angle += 360;
          push(angle);
          break;
        }
        case "exp": {
          const b = pop();
          push(Math.pow(pop(), b));
          break;
        }
        case "ln":
          push(Math.log(pop()));
          break;
        case "log":
          push(Math.log10(pop()));
          break;
        case "cvi":
          push(Math.trunc(pop()));
          break;
        case "cvr":
          push(pop());
          break;
        case "eq": {
          const b = stack.pop();
          const a = stack.pop();
          push(a === b);
          break;
        }
        case "ne": {
          const b = stack.pop();
          const a = stack.pop();
          push(a !== b);
          break;
        }
        case "gt": {
          const b = pop();
          push(pop() > b);
          break;
        }
        case "ge": {
          const b = pop();
          push(pop() >= b);
          break;
        }
        case "lt": {
          const b = pop();
          push(pop() < b);
          break;
        }
        case "le": {
          const b = pop();
          push(pop() <= b);
          break;
        }
        case "and": {
          const b = stack.pop();
          const a = stack.pop();
          push(typeof a === "boolean" ? a && Boolean(b) : Number(a) & Number(b));
          break;
        }
        case "or": {
          const b = stack.pop();
          const a = stack.pop();
          push(typeof a === "boolean" ? a || Boolean(b) : Number(a) | Number(b));
          break;
        }
        case "xor": {
          const b = stack.pop();
          const a = stack.pop();
          push(typeof a === "boolean" ? a !== Boolean(b) : Number(a) ^ Number(b));
          break;
        }
        case "not": {
          const a = stack.pop();
          push(typeof a === "boolean" ? !a : ~Number(a));
          break;
        }
        case "bitshift": {
          const shift = pop();
          const value = pop();
          push(shift >= 0 ? value << shift : value >> -shift);
          break;
        }
        case "dup": {
          const top = stack[stack.length - 1];
          if (top !== undefined) push(top);
          break;
        }
        case "pop":
          stack.pop();
          break;
        case "exch": {
          const b = stack.pop();
          const a = stack.pop();
          if (b !== undefined) push(b);
          if (a !== undefined) push(a);
          break;
        }
        case "copy": {
          const n = pop();
          const items = stack.slice(Math.max(0, stack.length - n));
          for (const item of items) push(item);
          break;
        }
        case "index": {
          const n = pop();
          const item = stack[stack.length - 1 - n];
          push(item ?? 0);
          break;
        }
        case "roll": {
          const j = pop();
          const n = pop();
          if (n > 0 && n <= stack.length) {
            const items = stack.splice(stack.length - n, n);
            const shift = ((j % n) + n) % n;
            stack.push(...items.slice(n - shift), ...items.slice(0, n - shift));
          }
          break;
        }
        default:
          throw new FunctionUnsupported(`PostScript operator '${node}' is not supported`);
      }
    }
  };
  execute(program);
  return stack.map((value) => (typeof value === "number" ? value : value ? 1 : 0));
}
