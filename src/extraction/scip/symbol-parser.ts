/**
 * SCIP symbol-string parser.
 *
 * A SCIP symbol is a URI-like string that uniquely identifies a class, method,
 * field, etc. CodeGraph uses it for two things:
 *   1. A stable node id — `hashScipSymbol` hashes the string so the same symbol
 *      always maps to the same `node.id`, whether seen as a definition or a
 *      cross-file reference. The original string is kept in `nodes.scip_symbol`.
 *   2. A `NodeKind` — derived from the trailing descriptor's suffix, and
 *      overridden by `SymbolInformation.kind` (SCIP 0.3+) when that is present.
 *
 * Grammar (from scip.proto):
 *   <symbol>     ::= <scheme> ' ' <package> ' ' (<descriptor>)+ | 'local ' <local-id>
 *   <package>    ::= <manager> ' ' <package-name> ' ' <version>
 *   <descriptor> ::= <name>'/' | <name>'#' | <name>'.' | <name>':' | <name>'!'
 *                  | <name>'(' <disambiguator>? ').' | '[' <name> ']' | '(' <name> ')'
 * Scheme/manager/package-name/version escape spaces as double-space; '.' is the
 * empty-value placeholder for manager/package-name/version. Names may be
 * backtick-escaped identifiers (double-backtick escapes a literal backtick).
 */

import * as crypto from 'crypto';
import type { NodeKind } from '../../types';

/** Thrown when a SCIP symbol string is structurally malformed. */
export class ScipSymbolParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScipSymbolParseError';
  }
}

/** Descriptor kinds, named after the SCIP grammar productions. */
export type ScipDescriptorSuffix =
  | 'namespace'
  | 'type'
  | 'term'
  | 'method'
  | 'type-parameter'
  | 'parameter'
  | 'meta'
  | 'macro'
  | 'local';

export interface ScipDescriptor {
  name: string;
  /** Present only for `method` descriptors with a disambiguator. */
  disambiguator?: string;
  suffix: ScipDescriptorSuffix;
}

export interface ScipPackage {
  manager: string;
  name: string;
  version: string;
}

export interface ParsedScipSymbol {
  scheme: string;
  package: ScipPackage;
  descriptors: ScipDescriptor[];
  /** True for `local <id>` symbols (Document-scoped, not globally addressable). */
  isLocal: boolean;
  /** Dotted fully-qualified name built from the descriptor names. */
  qualifiedName: string;
  /** The original, unmodified symbol string. */
  raw: string;
}

/** Identifier characters allowed in a `<simple-identifier>`. */
const IDENT_CHAR = /[A-Za-z0-9_+\-$]/;

const LOCAL_PREFIX = 'local ';

/**
 * Recursive-descent parser over a single SCIP symbol string. Created per-parse;
 * the public surface is the `parseScipSymbol` function below.
 */
class SymbolStringReader {
  private index = 0;

  constructor(private readonly s: string) {}

  private fail(message: string): never {
    throw new ScipSymbolParseError(
      `${message} (at offset ${this.index} of "${this.s}")`,
    );
  }

  private atEnd(): boolean {
    return this.index >= this.s.length;
  }

  private peek(offset = 0): string {
    return this.s[this.index + offset] ?? '';
  }

  private next(): string {
    const c = this.peek();
    this.index += 1;
    return c;
  }

  /** Read one space-delimited field; a doubled space is an escaped literal space. */
  private readSpaceEscapedField(): string {
    let out = '';
    while (!this.atEnd()) {
      if (this.peek() === ' ') {
        if (this.peek(1) === ' ') {
          out += ' ';
          this.index += 2;
          continue;
        }
        this.index += 1; // consume the single delimiter space
        return out;
      }
      out += this.next();
    }
    return out;
  }

  /** Read a contiguous run of simple-identifier characters (may be empty). */
  private readSimpleIdentifier(): string {
    let out = '';
    while (!this.atEnd() && IDENT_CHAR.test(this.peek())) {
      out += this.next();
    }
    return out;
  }

  /** Read a `<name>` — either a backtick-escaped or a simple identifier. */
  private readName(): string {
    if (this.peek() !== '`') {
      return this.readSimpleIdentifier();
    }
    this.index += 1; // opening backtick
    let out = '';
    while (!this.atEnd()) {
      const c = this.next();
      if (c === '`') {
        if (this.peek() === '`') {
          out += '`'; // doubled backtick -> literal backtick
          this.index += 1;
          continue;
        }
        return out; // closing backtick
      }
      out += c;
    }
    this.fail('unterminated escaped identifier');
  }

  /** Read a single descriptor starting at the current offset. */
  private readDescriptor(): ScipDescriptor {
    const lead = this.peek();

    if (lead === '(') {
      this.index += 1;
      const name = this.readName();
      if (this.next() !== ')') {
        this.fail("expected ')' closing a parameter descriptor");
      }
      return { name, suffix: 'parameter' };
    }

    if (lead === '[') {
      this.index += 1;
      const name = this.readName();
      if (this.next() !== ']') {
        this.fail("expected ']' closing a type-parameter descriptor");
      }
      return { name, suffix: 'type-parameter' };
    }

    const name = this.readName();
    if (this.atEnd()) {
      this.fail('expected a descriptor suffix');
    }
    const suffix = this.next();
    switch (suffix) {
      case '/':
        return { name, suffix: 'namespace' };
      case '#':
        return { name, suffix: 'type' };
      case '.':
        return { name, suffix: 'term' };
      case ':':
        return { name, suffix: 'meta' };
      case '!':
        return { name, suffix: 'macro' };
      case '(': {
        const disambiguator = this.readSimpleIdentifier();
        if (this.next() !== ')') {
          this.fail("expected ')' in a method descriptor");
        }
        if (this.next() !== '.') {
          this.fail("expected '.' after a method descriptor");
        }
        return {
          name,
          suffix: 'method',
          ...(disambiguator !== '' ? { disambiguator } : {}),
        };
      }
      default:
        return this.fail(`unknown descriptor suffix '${suffix}'`);
    }
  }

  parse(): ParsedScipSymbol {
    if (this.s.length === 0) {
      this.fail('empty symbol string');
    }

    // Local symbols: `local <local-id>`.
    if (this.s.startsWith(LOCAL_PREFIX)) {
      const localId = this.s.slice(LOCAL_PREFIX.length);
      return {
        scheme: 'local',
        package: { manager: '', name: '', version: '' },
        descriptors: [{ name: localId, suffix: 'local' }],
        isLocal: true,
        qualifiedName: localId,
        raw: this.s,
      };
    }

    const scheme = this.readSpaceEscapedField();
    if (scheme === '') {
      this.fail('symbol scheme must not be empty');
    }
    const manager = unplaceholder(this.readSpaceEscapedField());
    const packageName = unplaceholder(this.readSpaceEscapedField());
    const version = unplaceholder(this.readSpaceEscapedField());

    const descriptors: ScipDescriptor[] = [];
    while (!this.atEnd()) {
      descriptors.push(this.readDescriptor());
    }
    if (descriptors.length === 0) {
      this.fail('global symbol has no descriptors');
    }

    return {
      scheme,
      package: { manager, name: packageName, version },
      descriptors,
      isLocal: false,
      qualifiedName: descriptors.map((d) => d.name).join('.'),
      raw: this.s,
    };
  }
}

/** The SCIP `.` placeholder denotes an empty manager/package-name/version. */
function unplaceholder(field: string): string {
  return field === '.' ? '' : field;
}

/** Parse a SCIP symbol string. @throws {ScipSymbolParseError} on malformed input. */
export function parseScipSymbol(symbol: string): ParsedScipSymbol {
  return new SymbolStringReader(symbol).parse();
}

/**
 * Stable, symbol-derived node id. Prefixed `scip:` so it can never collide with
 * a tree-sitter node id (those are `<NodeKind>:<hash>`, and `scip` is not a
 * `NodeKind`). The hash is symbol-only — never kind-salted — so a symbol seen
 * as a definition and as a reference resolves to the same node.
 */
export function hashScipSymbol(symbol: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(symbol)
    .digest('hex')
    .substring(0, 32);
  return `scip:${hash}`;
}

/** Default `NodeKind` implied by a descriptor suffix when no `kind` is given. */
export function descriptorSuffixToNodeKind(suffix: ScipDescriptorSuffix): NodeKind {
  switch (suffix) {
    case 'namespace':
      return 'namespace';
    case 'type':
      return 'class';
    case 'term':
      return 'variable';
    case 'method':
      return 'method';
    case 'type-parameter':
      return 'parameter';
    case 'parameter':
      return 'parameter';
    case 'meta':
      return 'namespace';
    case 'macro':
      return 'function';
    case 'local':
      return 'variable';
    default:
      return 'variable';
  }
}

/**
 * SCIP `SymbolInformation.Kind` (the numeric enum) -> CodeGraph `NodeKind`.
 * Only well-known kinds are mapped; unmapped/`Unspecified` fall back to the
 * descriptor suffix. `Module` -> `module` is load-bearing for VB.NET.
 */
const SCIP_KIND_TO_NODE_KIND: Readonly<Record<number, NodeKind>> = {
  7: 'class', // Class
  75: 'class', // SingletonClass
  84: 'class', // Extension
  85: 'class', // Mixin
  62: 'class', // Contract
  49: 'struct', // Struct
  28: 'struct', // Message
  59: 'struct', // Union
  46: 'struct', // Signature (Alloy, analogous to Struct)
  21: 'interface', // Interface
  86: 'interface', // Concept
  42: 'protocol', // Protocol
  53: 'trait', // Trait
  56: 'trait', // TypeClass
  11: 'enum', // Enum
  12: 'enum_member', // EnumMember
  16: 'file', // File
  29: 'module', // Module  <-- VB.NET
  64: 'module', // Library
  30: 'namespace', // Namespace
  35: 'namespace', // Package
  36: 'namespace', // PackageObject
  17: 'function', // Function
  25: 'function', // Macro
  26: 'method', // Method
  66: 'method', // AbstractMethod
  80: 'method', // StaticMethod
  67: 'method', // MethodSpecification
  68: 'method', // ProtocolMethod
  69: 'method', // PureVirtualMethod
  70: 'method', // TraitMethod
  71: 'method', // TypeClassMethod
  76: 'method', // SingletonMethod
  74: 'method', // MethodAlias
  34: 'method', // Operator
  9: 'constructor', // Constructor
  13: 'event', // Event
  78: 'event', // StaticEvent
  41: 'property', // Property
  81: 'property', // StaticProperty
  18: 'property', // Getter
  45: 'property', // Setter
  72: 'property', // Accessor
  47: 'property', // Subscript
  15: 'field', // Field
  79: 'field', // StaticField
  77: 'field', // StaticDataMember
  8: 'constant', // Constant
  61: 'variable', // Variable
  82: 'variable', // StaticVariable
  60: 'variable', // Value
  37: 'parameter', // Parameter
  38: 'parameter', // ParameterLabel
  44: 'parameter', // SelfParameter
  52: 'parameter', // ThisParameter
  27: 'parameter', // MethodReceiver
  58: 'parameter', // TypeParameter
  54: 'type_alias', // Type
  55: 'type_alias', // TypeAlias
  3: 'type_alias', // AssociatedType
  57: 'type_alias', // TypeFamily
  10: 'type_alias', // DataFamily
  73: 'type_alias', // Delegate
};

/**
 * Resolve the `NodeKind` for a parsed symbol. `scipKind` (the numeric
 * `SymbolInformation.Kind`) wins when present and recognized; otherwise the
 * trailing descriptor's suffix decides.
 */
export function nodeKindForScipSymbol(
  parsed: ParsedScipSymbol,
  scipKind?: number,
): NodeKind {
  if (scipKind !== undefined && scipKind !== 0) {
    const mapped = SCIP_KIND_TO_NODE_KIND[scipKind];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  const last = parsed.descriptors[parsed.descriptors.length - 1];
  return last ? descriptorSuffixToNodeKind(last.suffix) : 'variable';
}
