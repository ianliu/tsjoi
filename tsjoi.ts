#!/usr/bin/env node

import * as ts from 'typescript'
import fs from 'fs'

let SUFFIX: string = ''

function all<T>(predicate: (x: T) => boolean, array: ReadonlyArray<T>): boolean {
  for (const x of array)
    if (!predicate(x))
      return false
  return true
}

function union2joi(tp: ts.UnionTypeNode): string {
  const types = tp.types.map(x => x.kind)

  if (tp.types.length === 2 && types.includes(ts.SyntaxKind.NullKeyword)) {
    const notnull = types[0] === ts.SyntaxKind.NullKeyword
      ? tp.types[1]
      : tp.types[0]
    return type2joi(notnull, false, 0) + '.allow(null)'
  }

  if (all(x => ts.isLiteralTypeNode(x) && ts.isStringLiteral(x.literal), tp.types)) {
    const values = tp.types
      .map(x => ((x as ts.LiteralTypeNode).literal as ts.StringLiteral).text)
      .map(x => `"${x}"`)
    return `Joi.string().valid([${values.join(", ")}])`
  }

  throw new Error(`Cannot convert the following type yet: ${tp.getText()}`)
}

function array2joi(tp: ts.ArrayTypeNode): string {
  const elementType = type2joi(tp.elementType, false, 0)
  return `Joi.array().items(${elementType})`
}

function literal2joi(tp: ts.TypeLiteralNode, indent: number): string {
  return propList2joi(tp.members, indent)
}

function reference2joi(tp: ts.TypeReferenceNode): string {
  if (ts.isIdentifier(tp.typeName)) {
    return `${tp.typeName.escapedText}${SUFFIX}`
  } else {
    throw new Error(`Cannot convert QualifiedName yet: ${tp.getText()}`)
  }
}

function type2joi(tp: ts.TypeNode, required: boolean, indent: number) {
  const r = required ? '.required()' : ''
  switch (tp.kind) {
    case ts.SyntaxKind.AnyKeyword:
    case ts.SyntaxKind.NumberKeyword:
    case ts.SyntaxKind.ObjectKeyword:
    case ts.SyntaxKind.BooleanKeyword:
    case ts.SyntaxKind.StringKeyword:
    case ts.SyntaxKind.SymbolKeyword:
    case ts.SyntaxKind.ThisKeyword:
    case ts.SyntaxKind.VoidKeyword:
    case ts.SyntaxKind.UndefinedKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.NeverKeyword:
      return 'Joi.' + tp.getText() + '()' + r
    case ts.SyntaxKind.UnionType:
      return union2joi(tp as ts.UnionTypeNode) + r
    case ts.SyntaxKind.ArrayType:
      return array2joi(tp as ts.ArrayTypeNode) + r
    case ts.SyntaxKind.TypeLiteral:
      return literal2joi(tp as ts.TypeLiteralNode, indent) + r
    case ts.SyntaxKind.TypeReference:
      return reference2joi(tp as ts.TypeReferenceNode) + r
  }
  throw new Error(`Cannot convert type ${tp.getText()} yet`)
}

function prop2joi(prop: ts.PropertySignature, indent: number = 0) {
  if (ts.isIdentifier(prop.name) && prop.type) {
    const required = prop.questionToken ? false : true
    const typeStr = type2joi(prop.type, required, indent)
    const prefix = Array(indent).fill(' ').join('')
    return `${prefix}${prop.name.escapedText}: ${typeStr}`
  } else {
    return null
  }
}

function propList2joi(members: ts.NodeArray<ts.TypeElement>, indent: number) {
  const prefix = Array(indent).fill(' ').join('')
  const props = members
    .filter(ts.isPropertySignature)
    .filter(x => ts.isIdentifier(x.name))
    .map(x => prop2joi(x, indent + 2))
    .join(',\n')
  return `Joi.object({\n${props}\n${prefix}})`
}

function makeTypeGuard(name: string, type: string, schema: string): string {
  return (
    `export function ${name}(obj: any): obj is T.${type} {\n` +
    `  return ${schema}.validate(obj).error === null\n` +
    `}\n`
  )
}

function stmt2joi(node: ts.Statement): string | null {
  if (ts.isInterfaceDeclaration(node)) {
    const identifier = node.name.getText()
    const properties = propList2joi(node.members, 0)
    const name = identifier + SUFFIX
    const guard = makeTypeGuard('is' + name, identifier, name)
    return `export const ${name} = ${properties}\n${guard}`
  }

  if (ts.isTypeAliasDeclaration(node)) {
    const identifier = node.name.getText()
    const typeStr = type2joi(node.type, false, 0)
    const name = identifier + SUFFIX
    const guard = makeTypeGuard('is' + name, identifier, name)
    return `export const ${name} = ${typeStr}\n${guard}`
  }

  return null
}

interface Options {
  input: string
  output: number
  suffix?: string
}

export default function ts2joi(txt: string, options: Partial<Options> = {}) {
  const opts = {
    suffix: '',
    input: 'foo.ts',
    ...options
  }

  SUFFIX = opts.suffix

  const source = ts.createSourceFile(
    opts.input, txt, ts.ScriptTarget.ES2015, true)

  const ifaces = source.statements
    .map(stmt2joi)
    .filter(x => x !== null)
    .join('\n\n')

  const fname = opts.input.endsWith('.ts')
    ? opts.input.slice(0, -3)
    : opts.input

  const importLine = (
    '// Automatically generated by tsjoi\n' +
    'import Joi from \'joi\'\n' +
    `import * as T from \'./${fname}\'\n` +
    '\n'
  )
  return `${importLine}${ifaces}`
}

function die(msg: string) {
  console.error(msg)
  process.exit(1)
}

function usage() {
  const lines = [
    'Usage: tsjoi [-s SUFFIX] INPUT [OUTPUT]',
    'Read TypeScript\'s types from INPUT and writes Joi schemas on OUTPUT'
  ]
  die(lines.join('\n'))
}

function getOpts(): Options {
  let args = process.argv.slice(2)
  let suffix: string | undefined

  if (args[0] === '-s') {
    suffix = args[1]
    args = args.slice(2)
  }

  if (args.length < 1 || args.length > 2)
    usage()

  const input = args[0] === '-' ? '/dev/stdin' : args[0]
  const output = args[1] ? fs.openSync(args[1], 'w') : 1

  const opts: Options = {
    input,
    output,
  }

  if (suffix)
    opts.suffix = suffix

  return opts
}

function main() {
  const opts = getOpts()
  const txt = fs.readFileSync(opts.input, { encoding: 'utf-8' })
  fs.writeSync(opts.output, ts2joi(txt, opts))
}

if (require.main === module) {
  main()
}

// vim:sw=2:et:sta
