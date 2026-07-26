// Breakpoint-debugger source instrumentation.
//
// Vivari has no V8 Inspector (guest code runs on the browser's own V8 inside a
// Web Worker, with no debug protocol reachable from there). So real, source-level
// breakpoints are implemented by INSTRUMENTING the guest source at load time:
// probe calls are woven into the code so a running program can pause itself, walk
// its own call stack, and evaluate expressions in a paused frame's scope. The
// probes drive a JS CDP Debugger backend (see debugger.js) that speaks the same
// Chrome DevTools Protocol the chii/chobitsu frontend already uses.
//
// This transform runs in the module loader (module.js `compile`) AFTER the
// TypeScript/JSX strip and BEFORE the ESM->CJS rewrite, i.e. on plain ECMAScript
// whose line numbers still match the user's original file (both of those transforms
// preserve line numbers). Insertions never add newlines, so `line`/`column`
// reported at runtime map 1:1 back to the editor.
//
// Woven probes (all reference the `__vvdbg` runtime global installed by index.js):
//   - Every lexical block (function body, if/for/while body, bare block, module
//     top level) gets a scope-local eval closure:
//         `const __vv_ev = function (e) { return eval(e); };`
//     Because it is a DIRECT eval defined at that exact scope, evaluating an
//     expression through it sees the block's own let/const/params/closures — this
//     is what powers evaluate-on-call-frame and the Scope panel, correctly, even
//     for block-scoped variables (a `for (let i…)` counter, an `if`-block const).
//   - Function bodies also push/pop a call-stack frame, wrapped in try/finally so
//     the frame pops on any exit (return/throw/normal):
//         `{ …directives… try { const __vv_ev=…; __vvdbg.push(SID,LINE,"name",
//            __vv_ev, [vars]); <body> } finally { __vvdbg.pop(); } }`
//   - Statements in a statement-list context (Program/Block/SwitchCase):
//         `__vvdbg.line(SID,LINE,__vv_ev);` before the statement.
//   - `debugger;`  ->  `__vvdbg.brk(SID,LINE,__vv_ev);` (an unconditional pause).
//
// Safety-first: instrumentation must NEVER break otherwise-valid code. On any
// parse failure the caller falls back to the un-instrumented source (that file is
// simply not breakpointable). Statement probes are only inserted where a statement
// is grammatically legal (never before the un-braced body of if/for/while/etc.),
// and block/module preambles are placed AFTER any directive prologue so a leading
// `"use strict"` keeps its effect.

import { Parser } from "./vendor/acorn.mjs";

const EV = "__vv_ev";
const EV_DECL = `const ${EV}=function(__vv_e){return eval(__vv_e);};`;

// Recursively visit every AST node. `visit(node, parent, key)` may return false to
// skip descending into that node's children.
function walk(node, visit, parent = null, key = null) {
  if (!node || typeof node.type !== "string") return;
  if (visit(node, parent, key) === false) return;
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "start" || k === "end" || k === "range") continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === "string") walk(c, visit, node, k);
    } else if (v && typeof v.type === "string") {
      walk(v, visit, node, k);
    }
  }
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

function collectPatternNames(node, out) {
  if (!node || typeof node.type !== "string") return;
  switch (node.type) {
    case "Identifier":
      out.add(node.name);
      break;
    case "AssignmentPattern":
      collectPatternNames(node.left, out);
      break;
    case "RestElement":
      collectPatternNames(node.argument, out);
      break;
    case "ArrayPattern":
      for (const el of node.elements) if (el) collectPatternNames(el, out);
      break;
    case "ObjectPattern":
      for (const p of node.properties) {
        if (p.type === "RestElement") collectPatternNames(p.argument, out);
        else collectPatternNames(p.value, out);
      }
      break;
    default:
      break;
  }
}

// Names visible inside a function's own scope + its nested blocks: params, plus
// every var/function/class/let/const declared anywhere in its body EXCEPT inside
// nested functions. The Scope panel evaluates each name through the innermost
// block's eval closure (defensively — TDZ / out-of-scope names are skipped), so an
// over-approximation here just means some names read as unavailable at some points.
function collectScopeVars(fnNode) {
  const names = new Set();
  for (const p of fnNode.params || []) collectPatternNames(p, names);
  const body = fnNode.body;
  if (!body || body.type !== "BlockStatement") return names;
  walk(body, (node) => {
    if (node === body) return true;
    if (FUNCTION_TYPES.has(node.type)) {
      if (node.type === "FunctionDeclaration" && node.id) names.add(node.id.name);
      return false;
    }
    if (node.type === "VariableDeclarator") collectPatternNames(node.id, names);
    else if (node.type === "ClassDeclaration" && node.id) names.add(node.id.name);
    else if (node.type === "ForStatement" || node.type === "ForInStatement" || node.type === "ForOfStatement") {
      if (node.left && node.left.type === "VariableDeclaration")
        for (const d of node.left.declarations) collectPatternNames(d.id, names);
      if (node.init && node.init.type === "VariableDeclaration")
        for (const d of node.init.declarations) collectPatternNames(d.id, names);
    } else if (node.type === "CatchClause" && node.param) {
      collectPatternNames(node.param, names);
    }
    return true;
  });
  return names;
}

function fnName(node, parent) {
  if (node.id && node.id.name) return node.id.name;
  if (parent) {
    if (parent.type === "VariableDeclarator" && parent.id && parent.id.name) return parent.id.name;
    if (parent.type === "AssignmentExpression" && parent.left && parent.left.type === "Identifier")
      return parent.left.name;
    if ((parent.type === "Property" || parent.type === "MethodDefinition") && parent.key) {
      if (parent.key.name) return parent.key.name;
      if (parent.key.value != null) return String(parent.key.value);
    }
  }
  return "(anonymous)";
}

function isProbableStatement(node) {
  switch (node.type) {
    case "ExpressionStatement":
    case "ReturnStatement":
    case "IfStatement":
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "SwitchStatement":
    case "ThrowStatement":
    case "TryStatement":
    case "VariableDeclaration":
    case "BreakStatement":
    case "ContinueStatement":
    case "BlockStatement":
    case "LabeledStatement":
    case "WithStatement":
      return true;
    default:
      return false;
  }
}

// Index of the first statement after a directive prologue (leading string-literal
// ExpressionStatements). Those must stay first, so preambles go after them.
function afterDirectives(body) {
  let i = 0;
  while (i < body.length && body[i].type === "ExpressionStatement" && typeof body[i].directive === "string") i++;
  return i;
}

/**
 * Instrument `source` for the given numeric `scriptId`.
 *
 * @returns {{ code: string, breakableLines: number[] }} on success.
 * @throws on parse failure — the caller should fall back to the original source.
 */
export function instrumentSource(source, scriptId) {
  const G = "__vvdbg";
  const sid = scriptId | 0;
  let ast;
  const baseOpts = {
    ecmaVersion: "latest",
    locations: true,
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
    allowSuperOutsideMethod: true,
  };
  try {
    ast = Parser.parse(source, { ...baseOpts, sourceType: "module" });
  } catch {
    ast = Parser.parse(source, { ...baseOpts, sourceType: "script" });
  }

  const edits = []; // { pos, order, text }
  const ins = (pos, text, order = 0) => edits.push({ pos, order, text });
  const breakable = new Set();
  const functionBodies = new WeakSet(); // BlockStatements that are function bodies

  const isStmtListParent = (parent, key) =>
    parent &&
    ((parent.type === "Program" && key === "body") ||
      (parent.type === "BlockStatement" && key === "body") ||
      (parent.type === "StaticBlock" && key === "body") ||
      (parent.type === "SwitchCase" && key === "consequent"));

  // Program-level eval closure (after any directive prologue), so top-level
  // statement/line probes can reference __vv_ev.
  {
    const k = afterDirectives(ast.body);
    const pos = k < ast.body.length ? ast.body[k].start : source.length;
    ins(pos, EV_DECL, -20);
  }

  walk(ast, (node, parent, key) => {
    // Function bodies: scope-local eval closure + call-stack frame, try/finally so
    // the frame always pops. The preamble is placed after any directive prologue.
    if (FUNCTION_TYPES.has(node.type) && node.body && node.body.type === "BlockStatement") {
      functionBodies.add(node.body);
      const B = node.body;
      const name = fnName(node, parent).replace(/["\\]/g, "\\$&");
      const line = node.loc.start.line;
      const vars = [...collectScopeVars(node)]
        .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n))
        .map((n) => JSON.stringify(n))
        .join(",");
      const k = afterDirectives(B.body);
      const insertPos = k < B.body.length ? B.body[k].start : B.end - 1;
      ins(insertPos, `try{${EV_DECL}${G}.push(${sid},${line},"${name}",${EV},[${vars}]);`, -10);
      ins(B.end - 1, `}finally{${G}.pop();}`, 10);
      return;
    }

    // Non-function lexical blocks get their own scope-local eval closure.
    if ((node.type === "BlockStatement" && !functionBodies.has(node)) || node.type === "StaticBlock") {
      const k = afterDirectives(node.body);
      const pos = k < node.body.length ? node.body[k].start : node.end - 1;
      ins(pos, EV_DECL, -15);
    }

    // `debugger;` -> forced pause.
    if (node.type === "DebuggerStatement") {
      const line = node.loc.start.line;
      breakable.add(line);
      ins(node.start, `${G}.brk(${sid},${line},${EV});`, 0);
      return;
    }

    // Per-statement line probes in a real statement-list context (skip directives).
    if (
      isStmtListParent(parent, key) &&
      isProbableStatement(node) &&
      !(node.type === "ExpressionStatement" && typeof node.directive === "string")
    ) {
      const line = node.loc.start.line;
      breakable.add(line);
      ins(node.start, `${G}.line(${sid},${line},${EV});`, 0);
    }
  });

  edits.sort((a, b) => b.pos - a.pos || b.order - a.order);
  let code = source;
  for (const e of edits) code = code.slice(0, e.pos) + e.text + code.slice(e.pos);

  return { code, breakableLines: [...breakable].sort((a, b) => a - b) };
}