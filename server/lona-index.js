"use strict";

const fs = require("fs");
const path = require("path");

const COMPLETION_ITEM_KIND = {
  METHOD: 2,
  FUNCTION: 3,
  VARIABLE: 6,
  MODULE: 9,
  PROPERTY: 10,
  STRUCT: 22,
  KEYWORD: 14
};

const KEYWORDS = [
  "import",
  "struct",
  "trait",
  "impl",
  "global",
  "def",
  "set",
  "var",
  "const",
  "ref",
  "if",
  "else",
  "for",
  "ret",
  "break",
  "continue",
  "cast",
  "true",
  "false",
  "null"
];

const LEXICAL_KEYWORDS = new Set(KEYWORDS);
const BUILTIN_TYPES = new Set([
  "type",
  "u8",
  "i8",
  "u16",
  "i16",
  "u32",
  "i32",
  "u64",
  "i64",
  "int",
  "uint",
  "f32",
  "f64",
  "bool",
  "usize"
]);

const BUILTIN_MEMBER_TABLE = [
  {
    match(typeText) {
      return normalizeTypeText(typeText) === "f32";
    },
    items: [
      {
        label: "tobits",
        kind: COMPLETION_ITEM_KIND.METHOD,
        detail: "builtin method -> u8[4]"
      }
    ]
  },
  {
    match(typeText) {
      return normalizeTypeText(typeText) === "u8[4]";
    },
    items: [
      {
        label: "tof32",
        kind: COMPLETION_ITEM_KIND.METHOD,
        detail: "builtin method -> f32"
      }
    ]
  }
];

function isIdentifierStart(ch) {
  return /[A-Za-z_]/.test(ch);
}

function isIdentifierPart(ch) {
  return /[A-Za-z0-9_]/.test(ch);
}

function isNumberPart(ch) {
  return /[A-Za-z0-9_.]/.test(ch);
}

function normalizeTypeText(text) {
  if (!text) {
    return null;
  }
  return text.replace(/\s+/g, " ").trim() || null;
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  let line = 0;
  let character = 0;

  const push = (type, value, start, end, tokenLine, tokenCharacter) => {
    tokens.push({
      type,
      value,
      start,
      end,
      line: tokenLine,
      character: tokenCharacter
    });
  };

  while (index < source.length) {
    const start = index;
    const tokenLine = line;
    const tokenCharacter = character;
    const ch = source[index];
    const next = source[index + 1];

    if (ch === " " || ch === "\t" || ch === "\v" || ch === "\f") {
      index += 1;
      character += 1;
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && next === "\n") {
        index += 2;
      } else {
        index += 1;
      }
      push("newline", "\n", start, index, tokenLine, tokenCharacter);
      line += 1;
      character = 0;
      continue;
    }

    if (ch === "/" && next === "/") {
      index += 2;
      character += 2;
      while (index < source.length && source[index] !== "\r" && source[index] !== "\n") {
        index += 1;
        character += 1;
      }
      continue;
    }

    if (ch === "\"" || ch === "'") {
      const quote = ch;
      index += 1;
      character += 1;
      while (index < source.length) {
        const current = source[index];
        if (current === "\\") {
          index += 2;
          character += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          character += 1;
          break;
        }
        if (current === "\r" || current === "\n") {
          break;
        }
        index += 1;
        character += 1;
      }
      push(quote === "\"" ? "string" : "char", source.slice(start, index), start, index, tokenLine, tokenCharacter);
      continue;
    }

    if (isIdentifierStart(ch)) {
      index += 1;
      character += 1;
      while (index < source.length && isIdentifierPart(source[index])) {
        index += 1;
        character += 1;
      }
      const value = source.slice(start, index);
      const type = LEXICAL_KEYWORDS.has(value) ? "keyword" : "identifier";
      push(type, value, start, index, tokenLine, tokenCharacter);
      continue;
    }

    if (/[0-9]/.test(ch)) {
      index += 1;
      character += 1;
      while (index < source.length && isNumberPart(source[index])) {
        index += 1;
        character += 1;
      }
      push("number", source.slice(start, index), start, index, tokenLine, tokenCharacter);
      continue;
    }

    const twoChar = source.slice(index, index + 2);
    const multiChar = new Set([
      ":=",
      "==",
      "!=",
      "<=",
      ">=",
      "&&",
      "||",
      "<<",
      ">>",
      "+=",
      "-=",
      "*=",
      "/=",
      "%=",
      "&=",
      "^=",
      "|="
    ]);
    if (multiChar.has(twoChar)) {
      index += 2;
      character += 2;
      push("punct", twoChar, start, index, tokenLine, tokenCharacter);
      continue;
    }

    index += 1;
    character += 1;
    push("punct", ch, start, index, tokenLine, tokenCharacter);
  }

  tokens.push({
    type: "eof",
    value: "<eof>",
    start: source.length,
    end: source.length,
    line,
    character
  });

  return tokens;
}

function tokenText(source, tokens, startIndex, endIndex) {
  if (startIndex >= endIndex || startIndex < 0 || endIndex <= 0) {
    return "";
  }
  const start = tokens[startIndex].start;
  const end = tokens[endIndex - 1].end;
  return normalizeTypeText(source.slice(start, end));
}

function tokenRange(token) {
  return {
    start: {
      line: token.line,
      character: token.character
    },
    end: {
      line: token.line,
      character: token.character + String(token.value || "").length
    }
  };
}

function findMatching(tokens, startIndex, openValue, closeValue, limit = tokens.length) {
  let depth = 0;
  for (let index = startIndex; index < limit; index += 1) {
    const token = tokens[index];
    if (token.value === openValue) {
      depth += 1;
    } else if (token.value === closeValue) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function skipTagLines(tokens, startIndex, limit = tokens.length) {
  let index = startIndex;
  while (index < limit && tokens[index].value === "#" && tokens[index + 1] && tokens[index + 1].value === "[") {
    const closeIndex = findMatching(tokens, index + 1, "[", "]", limit);
    if (closeIndex === -1) {
      return index + 1;
    }
    index = closeIndex + 1;
    while (index < limit && tokens[index].type === "newline") {
      index += 1;
    }
  }
  return index;
}

function consumeToLineEnd(tokens, startIndex, limit = tokens.length) {
  let index = startIndex;
  while (index < limit && tokens[index].type !== "newline" && tokens[index].type !== "eof") {
    index += 1;
  }
  if (index < limit && tokens[index].type === "newline") {
    index += 1;
  }
  return index;
}

function splitSegments(tokens, startIndex, endIndex) {
  const segments = [];
  let segmentStart = startIndex;
  let roundDepth = 0;
  let squareDepth = 0;
  let angleDepth = 0;
  for (let index = startIndex; index < endIndex; index += 1) {
    const token = tokens[index];
    if (token.value === "(") {
      roundDepth += 1;
    } else if (token.value === ")") {
      roundDepth = Math.max(0, roundDepth - 1);
    } else if (token.value === "[") {
      squareDepth += 1;
    } else if (token.value === "]") {
      squareDepth = Math.max(0, squareDepth - 1);
    } else if (token.value === "<") {
      angleDepth += 1;
    } else if (token.value === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
    } else if (token.value === "," && roundDepth === 0 && squareDepth === 0 && angleDepth === 0) {
      segments.push([segmentStart, index]);
      segmentStart = index + 1;
    }
  }
  if (segmentStart < endIndex) {
    segments.push([segmentStart, endIndex]);
  }
  return segments;
}

function extractImportAlias(importPath) {
  return importPath.split("/").filter(Boolean).pop() || importPath;
}

function extractLeadingTypeName(typeText) {
  const trimmed = normalizeTypeText(typeText);
  if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("(")) {
    return null;
  }
  const match = trimmed.match(/^[A-Za-z_][A-Za-z0-9_.]*/);
  return match ? match[0] : null;
}

function extractEmbeddedFieldName(typeText) {
  const leading = extractLeadingTypeName(typeText);
  if (!leading) {
    return "_";
  }
  const segments = leading.split(".");
  return segments[segments.length - 1];
}

function parseParameter(source, tokens, startIndex, endIndex) {
  let index = startIndex;
  while (index < endIndex && tokens[index].type === "newline") {
    index += 1;
  }
  if (index >= endIndex) {
    return null;
  }
  let nameIndex = index;
  if (tokens[index].value === "ref") {
    nameIndex += 1;
  }
  if (!tokens[nameIndex] || tokens[nameIndex].type !== "identifier") {
    return null;
  }
  const name = tokens[nameIndex].value;
  const typeText = tokenText(source, tokens, nameIndex + 1, endIndex);
  return {
    name,
    type: typeText,
    kind: "parameter",
    range: tokenRange(tokens[nameIndex])
  };
}

function parseFunctionLike(source, tokens, startIndex, ownerStruct) {
  let index = startIndex;
  let receiverWritable = false;
  if (tokens[index].value === "set" && tokens[index + 1] && tokens[index + 1].value === "def") {
    receiverWritable = true;
    index += 1;
  }
  if (!tokens[index] || tokens[index].value !== "def") {
    return null;
  }
  const nameToken = tokens[index + 1];
  if (!nameToken || nameToken.type !== "identifier") {
    return null;
  }

  index += 2;
  if (tokens[index] && tokens[index].value === "[") {
    const closeTypeParams = findMatching(tokens, index, "[", "]");
    if (closeTypeParams === -1) {
      return null;
    }
    index = closeTypeParams + 1;
  }

  if (!tokens[index] || tokens[index].value !== "(") {
    return null;
  }
  const closeParams = findMatching(tokens, index, "(", ")");
  if (closeParams === -1) {
    return null;
  }

  const params = [];
  const paramSegments = splitSegments(tokens, index + 1, closeParams);
  for (const [segmentStart, segmentEnd] of paramSegments) {
    const parsed = parseParameter(source, tokens, segmentStart, segmentEnd);
    if (parsed) {
      params.push(parsed);
    }
  }

  let cursor = closeParams + 1;
  const returnTypeStart = cursor;
  while (
    cursor < tokens.length &&
    tokens[cursor].type !== "newline" &&
    tokens[cursor].type !== "eof" &&
    tokens[cursor].value !== "{"
  ) {
    cursor += 1;
  }
  const returnType = tokenText(source, tokens, returnTypeStart, cursor);

  let bodyRange = null;
  let nextIndex = cursor;
  if (tokens[cursor] && tokens[cursor].value === "{") {
    const closeBody = findMatching(tokens, cursor, "{", "}");
    if (closeBody !== -1) {
      bodyRange = {
        openIndex: cursor,
        closeIndex: closeBody,
        contentStartOffset: tokens[cursor].end,
        contentEndOffset: tokens[closeBody].start
      };
      nextIndex = closeBody + 1;
    }
  } else {
    nextIndex = consumeToLineEnd(tokens, cursor);
  }

  return {
    symbol: {
      name: nameToken.value,
      ownerStruct: ownerStruct || null,
      params,
      returnType,
      receiverWritable,
      bodyRange,
      kind: ownerStruct ? "method" : "function",
      startOffset: tokens[startIndex].start,
      range: tokenRange(nameToken)
    },
    nextIndex
  };
}

function parseStructField(source, tokens, startIndex, limit) {
  let index = startIndex;
  let writable = false;
  if (tokens[index].value === "set" && (!tokens[index + 1] || tokens[index + 1].value !== "def")) {
    writable = true;
    index += 1;
  }
  const nameToken = tokens[index];
  if (!nameToken || nameToken.type !== "identifier") {
    return null;
  }
  const endIndex = consumeToLineEnd(tokens, index + 1, limit);
  if (nameToken.value === "_") {
    const fieldType = tokenText(source, tokens, index + 1, endIndex);
    return {
      field: {
        name: extractEmbeddedFieldName(fieldType),
        declaredType: fieldType,
        embedded: true,
        writable,
        range: tokenRange(nameToken)
      },
      nextIndex: endIndex
    };
  }
  const fieldType = tokenText(source, tokens, index + 1, endIndex);
  if (!fieldType) {
    return null;
  }
  return {
    field: {
      name: nameToken.value,
      declaredType: fieldType,
      embedded: false,
      writable,
      range: tokenRange(nameToken)
    },
    nextIndex: endIndex
  };
}

function findLastIdentifierToken(tokens, startIndex, endIndex) {
  for (let index = endIndex - 1; index >= startIndex; index -= 1) {
    if (tokens[index] && tokens[index].type === "identifier") {
      return tokens[index];
    }
  }
  return null;
}

function parseStructBody(documentIndex, source, tokens, structSymbol, openIndex, closeIndex) {
  let index = openIndex + 1;
  while (index < closeIndex) {
    while (index < closeIndex && tokens[index].type === "newline") {
      index += 1;
    }
    index = skipTagLines(tokens, index, closeIndex);
    if (index >= closeIndex) {
      break;
    }
    const parsedMethod = parseFunctionLike(source, tokens, index, structSymbol.name);
    if (parsedMethod) {
      structSymbol.methods.push(parsedMethod.symbol);
      documentIndex.functionBodies.push(parsedMethod.symbol);
      if (parsedMethod.symbol.bodyRange) {
        documentIndex.skipRanges.push({
          start: tokens[parsedMethod.symbol.bodyRange.openIndex].start,
          end: tokens[parsedMethod.symbol.bodyRange.closeIndex].end
        });
      }
      index = parsedMethod.nextIndex;
      continue;
    }
    const parsedField = parseStructField(source, tokens, index, closeIndex);
    if (parsedField) {
      structSymbol.fields.push(parsedField.field);
      index = parsedField.nextIndex;
      continue;
    }
    index += 1;
  }
}

function parseTraitBody(source, tokens, traitSymbol, openIndex, closeIndex) {
  let index = openIndex + 1;
  while (index < closeIndex) {
    while (index < closeIndex && tokens[index].type === "newline") {
      index += 1;
    }
    if (index >= closeIndex) {
      break;
    }
    const parsedMethod = parseFunctionLike(source, tokens, index, traitSymbol.name);
    if (parsedMethod) {
      traitSymbol.methods.push(parsedMethod.symbol);
      index = parsedMethod.nextIndex;
      continue;
    }
    index += 1;
  }
}

function buildDocumentIndex({ uri, filePath, text }) {
  const tokens = tokenize(text);
  const documentIndex = {
    uri,
    filePath,
    text,
    tokens,
    imports: [],
    importMap: new Map(),
    structs: new Map(),
    traits: new Map(),
    functions: new Map(),
    globals: new Map(),
    functionBodies: [],
    skipRanges: []
  };

  let index = 0;
  while (index < tokens.length && tokens[index].type !== "eof") {
    while (index < tokens.length && tokens[index].type === "newline") {
      index += 1;
    }
    index = skipTagLines(tokens, index);
    if (index >= tokens.length || tokens[index].type === "eof") {
      break;
    }

    const token = tokens[index];

    if (token.value === "import") {
      const endIndex = consumeToLineEnd(tokens, index + 1);
      const importPath = text
        .slice(tokens[index + 1] ? tokens[index + 1].start : token.end, tokens[endIndex - 1] ? tokens[endIndex - 1].end : token.end)
        .replace(/\s+/g, "");
      if (importPath) {
        const alias = extractImportAlias(importPath);
        const aliasToken = findLastIdentifierToken(tokens, index + 1, endIndex) || tokens[index];
        const importSymbol = {
          path: importPath,
          alias,
          range: tokenRange(aliasToken)
        };
        documentIndex.imports.push(importSymbol);
        documentIndex.importMap.set(alias, importSymbol);
      }
      index = endIndex;
      continue;
    }

    if (token.value === "struct") {
      const nameToken = tokens[index + 1];
      if (nameToken && nameToken.type === "identifier") {
        let cursor = index + 2;
        if (tokens[cursor] && tokens[cursor].value === "[") {
          const closeTypeParams = findMatching(tokens, cursor, "[", "]");
          if (closeTypeParams !== -1) {
            cursor = closeTypeParams + 1;
          }
        }
        const structSymbol = {
          name: nameToken.value,
          fields: [],
          methods: [],
          range: tokenRange(nameToken)
        };
        if (tokens[cursor] && tokens[cursor].value === "{") {
          const closeBody = findMatching(tokens, cursor, "{", "}");
          if (closeBody !== -1) {
            parseStructBody(documentIndex, text, tokens, structSymbol, cursor, closeBody);
            documentIndex.skipRanges.push({
              start: tokens[cursor].start,
              end: tokens[closeBody].end
            });
            cursor = closeBody + 1;
          }
        } else {
          cursor = consumeToLineEnd(tokens, cursor);
        }
        documentIndex.structs.set(structSymbol.name, structSymbol);
        index = cursor;
        continue;
      }
    }

    if (token.value === "trait") {
      const nameToken = tokens[index + 1];
      if (nameToken && nameToken.type === "identifier") {
        const traitSymbol = {
          name: nameToken.value,
          methods: [],
          range: tokenRange(nameToken)
        };
        documentIndex.traits.set(nameToken.value, traitSymbol);
      }
      let cursor = index + 2;
      if (tokens[cursor] && tokens[cursor].value === "{") {
        const closeBody = findMatching(tokens, cursor, "{", "}");
        if (closeBody !== -1) {
          const traitSymbol = documentIndex.traits.get(nameToken.value);
          if (traitSymbol) {
            parseTraitBody(text, tokens, traitSymbol, cursor, closeBody);
          }
          documentIndex.skipRanges.push({
            start: tokens[cursor].start,
            end: tokens[closeBody].end
          });
          cursor = closeBody + 1;
        }
      } else {
        cursor = consumeToLineEnd(tokens, cursor);
      }
      index = cursor;
      continue;
    }

    if (token.value === "impl") {
      let cursor = index + 1;
      while (cursor < tokens.length && tokens[cursor].type !== "newline" && tokens[cursor].type !== "eof" && tokens[cursor].value !== "{") {
        cursor += 1;
      }
      if (tokens[cursor] && tokens[cursor].value === "{") {
        const closeBody = findMatching(tokens, cursor, "{", "}");
        if (closeBody !== -1) {
          documentIndex.skipRanges.push({
            start: tokens[cursor].start,
            end: tokens[closeBody].end
          });
          cursor = closeBody + 1;
        }
      } else {
        cursor = consumeToLineEnd(tokens, cursor);
      }
      index = cursor;
      continue;
    }

    if (token.value === "global") {
      const nameToken = tokens[index + 1];
      if (nameToken && nameToken.type === "identifier") {
        const endIndex = consumeToLineEnd(tokens, index + 2);
        let assignmentIndex = -1;
        for (let cursor = index + 2; cursor < endIndex; cursor += 1) {
          if (tokens[cursor].value === "=") {
            assignmentIndex = cursor;
            break;
          }
        }
        const declaredType = assignmentIndex === -1
          ? tokenText(text, tokens, index + 2, endIndex)
          : tokenText(text, tokens, index + 2, assignmentIndex);
        documentIndex.globals.set(nameToken.value, {
          name: nameToken.value,
          declaredType,
          range: tokenRange(nameToken)
        });
        index = endIndex;
        continue;
      }
    }

    const parsedFunction = parseFunctionLike(text, tokens, index, null);
    if (parsedFunction) {
      documentIndex.functions.set(parsedFunction.symbol.name, parsedFunction.symbol);
      documentIndex.functionBodies.push(parsedFunction.symbol);
      if (parsedFunction.symbol.bodyRange) {
        documentIndex.skipRanges.push({
          start: tokens[parsedFunction.symbol.bodyRange.openIndex].start,
          end: tokens[parsedFunction.symbol.bodyRange.closeIndex].end
        });
      }
      index = parsedFunction.nextIndex;
      continue;
    }

    index += 1;
  }

  documentIndex.skipRanges.sort((left, right) => left.start - right.start);
  return documentIndex;
}

function positionToOffset(text, position) {
  const targetLine = position.line;
  const targetCharacter = position.character;
  let line = 0;
  let offset = 0;
  while (offset < text.length && line < targetLine) {
    const ch = text[offset];
    if (ch === "\n") {
      line += 1;
    }
    offset += 1;
  }
  return Math.min(offset + targetCharacter, text.length);
}

function offsetToPosition(text, offset) {
  let line = 0;
  let character = 0;
  for (let index = 0; index < Math.min(offset, text.length); index += 1) {
    if (text[index] === "\n") {
      line += 1;
      character = 0;
    } else {
      character += 1;
    }
  }
  return { line, character };
}

function collectVisibleSymbols(scopes) {
  const merged = new Map();
  for (const scope of scopes) {
    for (const [name, symbol] of scope.entries()) {
      merged.set(name, symbol);
    }
  }
  return merged;
}

function findStatementEnd(tokens, startIndex, endOffset) {
  let index = startIndex;
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  while (index < tokens.length && tokens[index].start < endOffset) {
    const token = tokens[index];
    if (token.type === "newline" && roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
      break;
    }
    if (token.value === "(") {
      roundDepth += 1;
    } else if (token.value === ")") {
      roundDepth = Math.max(0, roundDepth - 1);
    } else if (token.value === "[") {
      squareDepth += 1;
    } else if (token.value === "]") {
      squareDepth = Math.max(0, squareDepth - 1);
    } else if (token.value === "{") {
      curlyDepth += 1;
    } else if (token.value === "}") {
      if (curlyDepth === 0 && roundDepth === 0 && squareDepth === 0) {
        break;
      }
      curlyDepth = Math.max(0, curlyDepth - 1);
    }
    index += 1;
  }
  return index;
}

function findAssignment(tokens, startIndex, endIndex) {
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  for (let index = startIndex; index < endIndex; index += 1) {
    const token = tokens[index];
    if (token.value === "(") {
      roundDepth += 1;
    } else if (token.value === ")") {
      roundDepth = Math.max(0, roundDepth - 1);
    } else if (token.value === "[") {
      squareDepth += 1;
    } else if (token.value === "]") {
      squareDepth = Math.max(0, squareDepth - 1);
    } else if (token.value === "{") {
      curlyDepth += 1;
    } else if (token.value === "}") {
      curlyDepth = Math.max(0, curlyDepth - 1);
    } else if (token.value === "=" && roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
      return index;
    }
  }
  return -1;
}

function splitTupleItems(typeText) {
  const trimmed = normalizeTypeText(typeText);
  if (!trimmed || !trimmed.startsWith("<") || !trimmed.endsWith(">")) {
    return null;
  }
  const body = trimmed.slice(1, -1);
  const items = [];
  let segmentStart = 0;
  let roundDepth = 0;
  let squareDepth = 0;
  let angleDepth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const ch = body[index];
    if (ch === "(") {
      roundDepth += 1;
    } else if (ch === ")") {
      roundDepth = Math.max(0, roundDepth - 1);
    } else if (ch === "[") {
      squareDepth += 1;
    } else if (ch === "]") {
      squareDepth = Math.max(0, squareDepth - 1);
    } else if (ch === "<") {
      angleDepth += 1;
    } else if (ch === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
    } else if (ch === "," && roundDepth === 0 && squareDepth === 0 && angleDepth === 0) {
      items.push(normalizeTypeText(body.slice(segmentStart, index)));
      segmentStart = index + 1;
    }
  }
  items.push(normalizeTypeText(body.slice(segmentStart)));
  return items.filter(Boolean);
}

function qualifyImportedType(typeText, moduleAlias, moduleIndex) {
  const normalized = normalizeTypeText(typeText);
  if (!normalized) {
    return null;
  }
  const root = extractLeadingTypeName(normalized);
  if (!root || root.includes(".") || BUILTIN_TYPES.has(root)) {
    return normalized;
  }
  if (!moduleIndex.structs.has(root) && !moduleIndex.traits.has(root)) {
    return normalized;
  }
  return normalized.replace(root, `${moduleAlias}.${root}`);
}

function inferTypeFromInitializer(tokens, startIndex, endIndex, context) {
  if (startIndex >= endIndex) {
    return null;
  }
  const first = tokens[startIndex];
  if (!first) {
    return null;
  }

  if (first.value === "cast" && tokens[startIndex + 1] && tokens[startIndex + 1].value === "[") {
    const closeType = findMatching(tokens, startIndex + 1, "[", "]", endIndex);
    if (closeType !== -1) {
      return tokenText(context.currentIndex.text, tokens, startIndex + 2, closeType);
    }
  }

  if (first.value === "sizeof") {
    return "usize";
  }

  if (first.type === "string") {
    return "u8 const[*]";
  }

  if (first.type === "char") {
    return "u8";
  }

  if (first.type === "number") {
    return first.value.includes(".") ? "f32" : "i32";
  }

  if (first.value === "true" || first.value === "false") {
    return "bool";
  }

  if (first.type === "identifier" && tokens[startIndex + 1] && tokens[startIndex + 1].value === "(") {
    const symbolName = first.value;
    if (context.currentIndex.structs.has(symbolName)) {
      return symbolName;
    }
    if (context.currentIndex.functions.has(symbolName)) {
      return context.currentIndex.functions.get(symbolName).returnType || null;
    }
    if (context.visibleSymbols.has(symbolName)) {
      return context.visibleSymbols.get(symbolName).type || null;
    }
  }

  if (
    first.type === "identifier" &&
    tokens[startIndex + 1] &&
    tokens[startIndex + 1].value === "." &&
    tokens[startIndex + 2] &&
    tokens[startIndex + 2].type === "identifier" &&
    tokens[startIndex + 3] &&
    tokens[startIndex + 3].value === "("
  ) {
    const alias = first.value;
    const member = tokens[startIndex + 2].value;
    const importSymbol = context.currentIndex.importMap.get(alias);
    if (importSymbol) {
      const moduleIndex = context.resolveModuleIndex(importSymbol);
      if (moduleIndex) {
        if (moduleIndex.structs.has(member)) {
          return `${alias}.${member}`;
        }
        const functionSymbol = moduleIndex.functions.get(member);
        if (functionSymbol && functionSymbol.returnType) {
          return qualifyImportedType(functionSymbol.returnType, alias, moduleIndex);
        }
      }
    }
  }

  if (first.type === "identifier" && endIndex === startIndex + 1 && context.visibleSymbols.has(first.value)) {
    return context.visibleSymbols.get(first.value).type || null;
  }

  return null;
}

function tryParseBinding(tokens, startIndex, endOffset, context) {
  const first = tokens[startIndex];
  if (!first || first.type === "newline" || first.type === "eof") {
    return null;
  }

  if ((first.value === "var" || first.value === "const") && tokens[startIndex + 1] && tokens[startIndex + 1].type === "identifier") {
    const nameToken = tokens[startIndex + 1];
    const endIndex = findStatementEnd(tokens, startIndex, endOffset);
    const assignmentIndex = findAssignment(tokens, startIndex + 2, endIndex);
    const explicitType = assignmentIndex === -1
      ? tokenText(context.currentIndex.text, tokens, startIndex + 2, endIndex)
      : tokenText(context.currentIndex.text, tokens, startIndex + 2, assignmentIndex);
    const inferredType = assignmentIndex === -1
      ? null
      : inferTypeFromInitializer(tokens, assignmentIndex + 1, endIndex, context);
    return {
      symbol: {
        name: nameToken.value,
        type: explicitType || inferredType,
        kind: "local",
        range: tokenRange(nameToken)
      },
      nextIndex: endIndex
    };
  }

  if (first.value === "ref" && tokens[startIndex + 1] && tokens[startIndex + 1].type === "identifier") {
    const nameToken = tokens[startIndex + 1];
    const endIndex = findStatementEnd(tokens, startIndex, endOffset);
    const assignmentIndex = findAssignment(tokens, startIndex + 2, endIndex);
    const explicitType = assignmentIndex === -1
      ? tokenText(context.currentIndex.text, tokens, startIndex + 2, endIndex)
      : tokenText(context.currentIndex.text, tokens, startIndex + 2, assignmentIndex);
    return {
      symbol: {
        name: nameToken.value,
        type: explicitType,
        kind: "local",
        range: tokenRange(nameToken)
      },
      nextIndex: endIndex
    };
  }

  if (
    first.type === "identifier" &&
    ((tokens[startIndex + 1] && tokens[startIndex + 1].value === ":=") ||
      (tokens[startIndex + 1] && tokens[startIndex + 1].value === ":" && tokens[startIndex + 2] && tokens[startIndex + 2].value === "="))
  ) {
    const assignmentIndex = tokens[startIndex + 1].value === ":=" ? startIndex + 1 : startIndex + 2;
    const endIndex = findStatementEnd(tokens, startIndex, endOffset);
    return {
      symbol: {
        name: first.value,
        type: inferTypeFromInitializer(tokens, assignmentIndex + 1, endIndex, context),
        kind: "local",
        range: tokenRange(first)
      },
      nextIndex: endIndex
    };
  }

  return null;
}

function collectBindingsBeforeOffset(documentIndex, offset, options) {
  const { startIndex, endOffset, initialSymbols = [], skipRanges = [] } = options;
  const scopes = [new Map()];
  for (const symbol of initialSymbols) {
    scopes[0].set(symbol.name, symbol);
  }
  let statementStart = true;
  let roundDepth = 0;
  let squareDepth = 0;
  let cursor = startIndex;
  let skipIndex = 0;

  while (cursor < documentIndex.tokens.length && documentIndex.tokens[cursor].start < endOffset) {
    const token = documentIndex.tokens[cursor];

    while (skipIndex < skipRanges.length && token.start >= skipRanges[skipIndex].end) {
      skipIndex += 1;
    }
    if (skipIndex < skipRanges.length && token.start >= skipRanges[skipIndex].start && token.start < skipRanges[skipIndex].end) {
      while (cursor < documentIndex.tokens.length && documentIndex.tokens[cursor].start < skipRanges[skipIndex].end) {
        cursor += 1;
      }
      statementStart = true;
      continue;
    }

    if (token.type === "newline") {
      if (roundDepth === 0 && squareDepth === 0) {
        statementStart = true;
      }
      cursor += 1;
      continue;
    }

    if (statementStart) {
      const afterTags = skipTagLines(documentIndex.tokens, cursor);
      if (afterTags !== cursor) {
        cursor = afterTags;
        statementStart = true;
        continue;
      }
      const parsed = tryParseBinding(documentIndex.tokens, cursor, endOffset, {
        currentIndex: documentIndex,
        visibleSymbols: collectVisibleSymbols(scopes),
        resolveModuleIndex: options.resolveModuleIndex
      });
      if (parsed) {
        scopes[scopes.length - 1].set(parsed.symbol.name, parsed.symbol);
        cursor = parsed.nextIndex;
        statementStart = false;
        continue;
      }
      statementStart = false;
    }

    if (token.value === "{") {
      scopes.push(new Map());
      statementStart = true;
    } else if (token.value === "}") {
      if (scopes.length > 1) {
        scopes.pop();
      }
      statementStart = true;
    } else if (token.value === "(") {
      roundDepth += 1;
    } else if (token.value === ")") {
      roundDepth = Math.max(0, roundDepth - 1);
    } else if (token.value === "[") {
      squareDepth += 1;
    } else if (token.value === "]") {
      squareDepth = Math.max(0, squareDepth - 1);
    }

    cursor += 1;
  }

  return collectVisibleSymbols(scopes);
}

function findInnermostFunction(documentIndex, offset) {
  let bestMatch = null;
  for (const functionSymbol of documentIndex.functionBodies) {
    if (!functionSymbol.bodyRange) {
      continue;
    }
    if (offset < functionSymbol.bodyRange.contentStartOffset || offset > functionSymbol.bodyRange.contentEndOffset) {
      continue;
    }
    if (!bestMatch) {
      bestMatch = functionSymbol;
      continue;
    }
    const currentSpan = functionSymbol.bodyRange.contentEndOffset - functionSymbol.bodyRange.contentStartOffset;
    const bestSpan = bestMatch.bodyRange.contentEndOffset - bestMatch.bodyRange.contentStartOffset;
    if (currentSpan < bestSpan) {
      bestMatch = functionSymbol;
    }
  }
  return bestMatch;
}

function getCompletionContext(text, offset) {
  let start = offset;
  while (start > 0 && isIdentifierPart(text[start - 1])) {
    start -= 1;
  }
  const prefix = text.slice(start, offset);
  let scan = start - 1;
  while (scan >= 0 && /[ \t]/.test(text[scan])) {
    scan -= 1;
  }
  if (scan >= 0 && text[scan] === ".") {
    const leftText = text.slice(0, scan);
    const match = leftText.match(/([A-Za-z_][A-Za-z0-9_]*(?:[ \t]*\.[ \t]*[A-Za-z_][A-Za-z0-9_]*)*)[ \t]*$/);
    if (match) {
      return {
        prefix,
        dotAccess: true,
        leftExpression: match[1].replace(/[ \t]+/g, "")
      };
    }
  }
  return {
    prefix,
    dotAccess: false,
    leftExpression: null
  };
}

function normalizeReceiverType(typeText) {
  let current = normalizeTypeText(typeText);
  if (!current) {
    return null;
  }
  while (true) {
    if (current.endsWith(" dyn")) {
      current = current.slice(0, -4).trim();
      continue;
    }
    if (current.endsWith(" const")) {
      current = current.slice(0, -6).trim();
      continue;
    }
    if (current.endsWith("[*]")) {
      current = current.slice(0, -3).trim();
      continue;
    }
    if (current.endsWith("*")) {
      current = current.slice(0, -1).trim();
      continue;
    }
    break;
  }
  return current;
}

function resolveTypeTarget(typeText, context) {
  const normalized = normalizeReceiverType(typeText);
  if (!normalized) {
    return null;
  }

  const tupleItems = splitTupleItems(normalized);
  if (tupleItems) {
    return {
      kind: "tuple",
      itemTypes: tupleItems
    };
  }

  for (const rule of BUILTIN_MEMBER_TABLE) {
    if (rule.match(normalized)) {
      return {
        kind: "builtin",
        typeText: normalized,
        items: rule.items
      };
    }
  }

  const leading = extractLeadingTypeName(normalized);
  if (!leading) {
    return null;
  }

  if (leading.includes(".")) {
    const segments = leading.split(".");
    if (segments.length === 2) {
      const [alias, name] = segments;
      const importSymbol = context.currentIndex.importMap.get(alias);
      if (importSymbol) {
        const moduleIndex = context.resolveModuleIndex(importSymbol);
        if (moduleIndex && moduleIndex.structs.has(name)) {
          return {
            kind: "struct",
            struct: moduleIndex.structs.get(name),
            moduleAlias: alias,
            moduleIndex
          };
        }
        if (moduleIndex && moduleIndex.traits.has(name)) {
          return {
            kind: "trait",
            trait: moduleIndex.traits.get(name),
            moduleAlias: alias,
            moduleIndex
          };
        }
      }
    }
  }

  if (context.currentIndex.structs.has(leading)) {
    return {
      kind: "struct",
      struct: context.currentIndex.structs.get(leading),
      moduleAlias: null,
      moduleIndex: context.currentIndex
    };
  }

  if (context.currentIndex.traits.has(leading)) {
    return {
      kind: "trait",
      trait: context.currentIndex.traits.get(leading),
      moduleAlias: null,
      moduleIndex: context.currentIndex
    };
  }

  return null;
}

function resolveMemberType(memberType, moduleAlias, moduleIndex) {
  if (!memberType) {
    return null;
  }
  if (!moduleAlias || !moduleIndex) {
    return memberType;
  }
  return qualifyImportedType(memberType, moduleAlias, moduleIndex);
}

function resolveChainTarget(leftExpression, context) {
  const segments = leftExpression.split(".").filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  let current = null;
  const first = segments[0];
  if (context.visibleSymbols.has(first)) {
    current = {
      kind: "value",
      typeText: context.visibleSymbols.get(first).type || null
    };
  } else if (context.currentIndex.importMap.has(first)) {
    const importSymbol = context.currentIndex.importMap.get(first);
    const moduleIndex = context.resolveModuleIndex(importSymbol);
    if (!moduleIndex) {
      return null;
    }
    current = {
      kind: "module",
      alias: first,
      moduleIndex
    };
  } else if (context.currentIndex.structs.has(first)) {
    current = {
      kind: "struct",
      struct: context.currentIndex.structs.get(first),
      moduleAlias: null,
      moduleIndex: context.currentIndex
    };
  } else {
    return null;
  }

  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];

    if (current.kind === "value") {
      current = resolveTypeTarget(current.typeText, context);
      if (!current) {
        return null;
      }
    }

    if (current.kind === "module") {
      if (current.moduleIndex.structs.has(segment)) {
        current = {
          kind: "struct",
          struct: current.moduleIndex.structs.get(segment),
          moduleAlias: current.alias,
          moduleIndex: current.moduleIndex
        };
        continue;
      }
      if (current.moduleIndex.functions.has(segment)) {
        const functionSymbol = current.moduleIndex.functions.get(segment);
        current = {
          kind: "value",
          typeText: resolveMemberType(functionSymbol.returnType, current.alias, current.moduleIndex)
        };
        continue;
      }
      if (current.moduleIndex.globals.has(segment)) {
        const globalSymbol = current.moduleIndex.globals.get(segment);
        current = {
          kind: "value",
          typeText: resolveMemberType(globalSymbol.declaredType, current.alias, current.moduleIndex)
        };
        continue;
      }
      return null;
    }

    if (current.kind === "builtin") {
      return null;
    }

    if (current.kind === "tuple") {
      if (!/^_\d+$/.test(segment)) {
        return null;
      }
      const itemIndex = Number.parseInt(segment.slice(1), 10) - 1;
      current = {
        kind: "value",
        typeText: current.itemTypes[itemIndex] || null
      };
      continue;
    }

    if (current.kind === "struct") {
      const field = current.struct.fields.find((candidate) => candidate.name === segment);
      if (field) {
        current = {
          kind: "value",
          typeText: resolveMemberType(field.declaredType, current.moduleAlias, current.moduleIndex)
        };
        continue;
      }
      const method = current.struct.methods.find((candidate) => candidate.name === segment);
      if (method) {
        current = {
          kind: "value",
          typeText: resolveMemberType(method.returnType, current.moduleAlias, current.moduleIndex)
        };
        continue;
      }
      return null;
    }
  }

  if (current.kind === "value") {
    return resolveTypeTarget(current.typeText, context);
  }
  return current;
}

function addCompletion(targetMap, item) {
  const key = `${item.kind}:${item.label}`;
  if (!targetMap.has(key)) {
    targetMap.set(key, item);
  }
}

function makeTopLevelItems(documentIndex) {
  const items = [];
  for (const importSymbol of documentIndex.imports) {
    items.push({
      label: importSymbol.alias,
      kind: COMPLETION_ITEM_KIND.MODULE,
      detail: `import ${importSymbol.path}`
    });
  }
  for (const structSymbol of documentIndex.structs.values()) {
    items.push({
      label: structSymbol.name,
      kind: COMPLETION_ITEM_KIND.STRUCT,
      detail: "struct"
    });
  }
  for (const functionSymbol of documentIndex.functions.values()) {
    items.push({
      label: functionSymbol.name,
      kind: COMPLETION_ITEM_KIND.FUNCTION,
      detail: formatFunctionDetail(functionSymbol)
    });
  }
  for (const globalSymbol of documentIndex.globals.values()) {
    items.push({
      label: globalSymbol.name,
      kind: COMPLETION_ITEM_KIND.VARIABLE,
      detail: globalSymbol.declaredType ? `global ${globalSymbol.declaredType}` : "global"
    });
  }
  for (const traitSymbol of documentIndex.traits.values()) {
    items.push({
      label: traitSymbol.name,
      kind: COMPLETION_ITEM_KIND.STRUCT,
      detail: "trait"
    });
  }
  return items;
}

function formatFunctionDetail(functionSymbol) {
  const params = functionSymbol.params.map((param) => {
    return param.type ? `${param.name} ${param.type}` : param.name;
  }).join(", ");
  const prefix = functionSymbol.ownerStruct ? "method" : "def";
  const suffix = functionSymbol.returnType ? ` ${functionSymbol.returnType}` : "";
  return `${prefix} ${functionSymbol.name}(${params})${suffix}`;
}

function memberItemsForTarget(target) {
  if (!target) {
    return [];
  }
  if (target.kind === "module") {
    return makeTopLevelItems(target.moduleIndex);
  }
  if (target.kind === "builtin") {
    return target.items;
  }
  if (target.kind === "tuple") {
    return target.itemTypes.map((typeText, index) => ({
      label: `_${index + 1}`,
      kind: COMPLETION_ITEM_KIND.PROPERTY,
      detail: typeText || "tuple member"
    }));
  }
  if (target.kind === "struct") {
    const items = [];
    for (const field of target.struct.fields) {
      items.push({
        label: field.name,
        kind: COMPLETION_ITEM_KIND.PROPERTY,
        detail: field.declaredType || "field"
      });
    }
    for (const method of target.struct.methods) {
      items.push({
        label: method.name,
        kind: COMPLETION_ITEM_KIND.METHOD,
        detail: formatFunctionDetail(method)
      });
    }
    return items;
  }
  if (target.kind === "trait") {
    return target.trait.methods.map((method) => ({
      label: method.name,
      kind: COMPLETION_ITEM_KIND.METHOD,
      detail: formatFunctionDetail(method)
    }));
  }
  return [];
}

function buildCompletionItems(documentIndex, offset, resolveModuleIndex) {
  const context = getCompletionContext(documentIndex.text, offset);
  const currentFunction = findInnermostFunction(documentIndex, offset);

  let visibleSymbols;
  if (currentFunction && currentFunction.bodyRange) {
    const initialSymbols = currentFunction.params.map((param) => ({
      name: param.name,
      type: param.type,
      kind: "parameter"
    }));
    if (currentFunction.ownerStruct) {
      initialSymbols.push({
        name: "self",
        type: currentFunction.ownerStruct,
        kind: "parameter"
      });
    }
    visibleSymbols = collectBindingsBeforeOffset(documentIndex, offset, {
      startIndex: currentFunction.bodyRange.openIndex + 1,
      endOffset: offset,
      initialSymbols,
      resolveModuleIndex
    });
  } else {
    visibleSymbols = collectBindingsBeforeOffset(documentIndex, offset, {
      startIndex: 0,
      endOffset: offset,
      skipRanges: documentIndex.skipRanges,
      resolveModuleIndex
    });
  }

  const completionContext = {
    currentIndex: documentIndex,
    visibleSymbols,
    resolveModuleIndex
  };

  const items = new Map();
  if (context.dotAccess) {
    const target = resolveChainTarget(context.leftExpression, completionContext);
    for (const item of memberItemsForTarget(target)) {
      addCompletion(items, item);
    }
  } else {
    for (const keyword of KEYWORDS) {
      addCompletion(items, {
        label: keyword,
        kind: COMPLETION_ITEM_KIND.KEYWORD,
        detail: "keyword"
      });
    }
    for (const symbol of visibleSymbols.values()) {
      addCompletion(items, {
        label: symbol.name,
        kind: COMPLETION_ITEM_KIND.VARIABLE,
        detail: symbol.type || symbol.kind
      });
    }
    for (const item of makeTopLevelItems(documentIndex)) {
      addCompletion(items, item);
    }
  }

  return Array.from(items.values())
    .sort((left, right) => left.label.localeCompare(right.label, "en"));
}

function findIdentifierTokenIndex(tokens, offset) {
  let fallback = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "identifier") {
      if (offset >= token.start && offset <= token.end) {
        return index;
      }
      if (offset === token.end + 1) {
        fallback = index;
      }
    }
    if (token.start > offset) {
      break;
    }
  }
  return fallback;
}

function findTokenBeforeOffset(tokens, offset) {
  let fallback = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "eof") {
      return fallback;
    }
    if (offset > token.start && offset <= token.end) {
      return index;
    }
    if (token.end <= offset) {
      fallback = index;
      continue;
    }
    if (token.start > offset) {
      return fallback;
    }
  }
  return fallback;
}

function findMatchingBackward(tokens, startIndex, openValue, closeValue) {
  let depth = 0;
  for (let index = startIndex; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token.value === closeValue) {
      depth += 1;
    } else if (token.value === openValue) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function getReferenceContext(documentIndex, offset) {
  const tokenIndex = findIdentifierTokenIndex(documentIndex.tokens, offset);
  if (tokenIndex === -1) {
    return null;
  }
  let startIndex = tokenIndex;
  while (
    startIndex - 2 >= 0 &&
    documentIndex.tokens[startIndex - 1].value === "." &&
    documentIndex.tokens[startIndex - 2].type === "identifier"
  ) {
    startIndex -= 2;
  }
  let endIndex = tokenIndex;
  while (
    endIndex + 2 < documentIndex.tokens.length &&
    documentIndex.tokens[endIndex + 1].value === "." &&
    documentIndex.tokens[endIndex + 2].type === "identifier"
  ) {
    endIndex += 2;
  }

  const segments = [];
  for (let index = startIndex; index <= endIndex; index += 2) {
    segments.push(documentIndex.tokens[index].value);
  }

  return {
    segments,
    targetSegmentIndex: Math.floor((tokenIndex - startIndex) / 2)
  };
}

function parseCallSegmentsBeforeIndex(tokens, startIndex) {
  let index = startIndex;
  while (index >= 0 && tokens[index].type === "newline") {
    index -= 1;
  }
  if (index < 0) {
    return null;
  }
  if (tokens[index].value === "]") {
    const openIndex = findMatchingBackward(tokens, index, "[", "]");
    if (openIndex === -1) {
      return null;
    }
    index = openIndex - 1;
    while (index >= 0 && tokens[index].type === "newline") {
      index -= 1;
    }
  }
  if (index < 0 || tokens[index].type !== "identifier") {
    return null;
  }

  const segments = [tokens[index].value];
  index -= 1;
  while (
    index - 1 >= 0 &&
    tokens[index].value === "." &&
    tokens[index - 1].type === "identifier"
  ) {
    segments.push(tokens[index - 1].value);
    index -= 2;
  }

  return segments.reverse();
}

function getSignatureContext(documentIndex, offset) {
  const tokenIndex = findTokenBeforeOffset(documentIndex.tokens, offset);
  if (tokenIndex === -1) {
    return null;
  }

  let roundDepth = 0;
  let squareDepth = 0;
  let braceDepth = 0;
  let activeParameter = 0;

  for (let index = tokenIndex; index >= 0; index -= 1) {
    const token = documentIndex.tokens[index];
    if (token.value === ")") {
      if (squareDepth === 0 && braceDepth === 0) {
        roundDepth += 1;
      }
      continue;
    }
    if (token.value === "(") {
      if (squareDepth !== 0 || braceDepth !== 0) {
        continue;
      }
      if (roundDepth > 0) {
        roundDepth -= 1;
        continue;
      }
      const segments = parseCallSegmentsBeforeIndex(documentIndex.tokens, index - 1);
      if (!segments || segments.length === 0) {
        return null;
      }
      return {
        segments,
        activeParameter,
        openIndex: index
      };
    }
    if (token.value === "]") {
      squareDepth += 1;
      continue;
    }
    if (token.value === "[") {
      if (squareDepth > 0) {
        squareDepth -= 1;
      }
      continue;
    }
    if (token.value === "}") {
      braceDepth += 1;
      continue;
    }
    if (token.value === "{") {
      if (braceDepth > 0) {
        braceDepth -= 1;
      }
      continue;
    }
    if (token.value === "," && roundDepth === 0 && squareDepth === 0 && braceDepth === 0) {
      activeParameter += 1;
    }
  }

  return null;
}

function makeDefinitionLocation(filePath, symbol) {
  if (!filePath || !symbol || !symbol.range) {
    return null;
  }
  return {
    path: filePath,
    range: symbol.range
  };
}

function resolveTopLevelDefinition(moduleIndex, name) {
  if (moduleIndex.importMap.has(name)) {
    return {
      kind: "import",
      symbol: moduleIndex.importMap.get(name),
      moduleIndex
    };
  }
  if (moduleIndex.structs.has(name)) {
    return {
      kind: "struct",
      symbol: moduleIndex.structs.get(name),
      moduleIndex
    };
  }
  if (moduleIndex.functions.has(name)) {
    return {
      kind: "function",
      symbol: moduleIndex.functions.get(name),
      moduleIndex
    };
  }
  if (moduleIndex.globals.has(name)) {
    return {
      kind: "global",
      symbol: moduleIndex.globals.get(name),
      moduleIndex
    };
  }
  if (moduleIndex.traits.has(name)) {
    return {
      kind: "trait",
      symbol: moduleIndex.traits.get(name),
      moduleIndex
    };
  }
  return null;
}

function resolveRootState(name, context) {
  if (context.visibleSymbols.has(name)) {
    const symbol = context.visibleSymbols.get(name);
    return {
      kind: "value",
      symbol,
      moduleIndex: context.currentIndex,
      typeText: symbol.type || null
    };
  }
  if (context.currentIndex.importMap.has(name)) {
    const importSymbol = context.currentIndex.importMap.get(name);
    const moduleIndex = context.resolveModuleIndex(importSymbol);
    return {
      kind: "module",
      symbol: importSymbol,
      moduleIndex,
      alias: name
    };
  }
  const definition = resolveTopLevelDefinition(context.currentIndex, name);
  if (!definition) {
    return null;
  }
  if (definition.kind === "struct") {
    return {
      kind: "struct",
      symbol: definition.symbol,
      moduleIndex: context.currentIndex,
      moduleAlias: null
    };
  }
  if (definition.kind === "function") {
    return {
      kind: "function",
      symbol: definition.symbol,
      moduleIndex: context.currentIndex
    };
  }
  if (definition.kind === "global") {
    return {
      kind: "global",
      symbol: definition.symbol,
      moduleIndex: context.currentIndex
    };
  }
  if (definition.kind === "trait") {
    return {
      kind: "trait",
      symbol: definition.symbol,
      moduleIndex: context.currentIndex
    };
  }
  return {
    kind: "import",
    symbol: definition.symbol,
    moduleIndex: context.currentIndex
  };
}

function definitionLocationForState(state, currentIndex) {
  if (!state) {
    return null;
  }
  if (state.kind === "value") {
    return makeDefinitionLocation(currentIndex.filePath, state.symbol);
  }
  if (state.kind === "module" || state.kind === "import") {
    return makeDefinitionLocation(currentIndex.filePath, state.symbol);
  }
  return makeDefinitionLocation(state.moduleIndex && state.moduleIndex.filePath, state.symbol);
}

function hoverRangeForState(state, currentIndex) {
  if (!state || !state.symbol || !state.symbol.range) {
    return null;
  }
  if (state.kind === "value") {
    return state.symbol.range;
  }
  if (state.kind === "module" || state.kind === "import") {
    return state.symbol.range;
  }
  if (state.moduleIndex && state.moduleIndex.filePath !== currentIndex.filePath) {
    return null;
  }
  return state.symbol.range;
}

function makeHoverInfo(code, text, range) {
  const contents = [];
  if (code) {
    contents.push({
      language: "lona",
      value: code
    });
  }
  if (text) {
    contents.push({
      kind: "plaintext",
      value: text
    });
  }
  if (contents.length === 0) {
    return null;
  }
  return range ? { contents, range } : { contents };
}

function hoverInfoForState(state, currentIndex) {
  if (!state) {
    return null;
  }

  const range = hoverRangeForState(state, currentIndex);

  if (state.kind === "value") {
    const prefix = state.symbol.kind === "parameter" ? "param" : "var";
    const suffix = state.symbol.type ? ` ${state.symbol.type}` : "";
    return makeHoverInfo(`${prefix} ${state.symbol.name}${suffix}`, null, range);
  }

  if (state.kind === "module" || state.kind === "import") {
    return makeHoverInfo(`import ${state.symbol.path}`, null, range);
  }

  if (state.kind === "struct") {
    return makeHoverInfo(`struct ${state.symbol.name}`, null, range);
  }

  if (state.kind === "trait") {
    return makeHoverInfo(`trait ${state.symbol.name}`, null, range);
  }

  if (state.kind === "function" || state.kind === "method") {
    return makeHoverInfo(formatFunctionDetail(state.symbol), null, range);
  }

  if (state.kind === "global") {
    const suffix = state.symbol.declaredType ? ` ${state.symbol.declaredType}` : "";
    return makeHoverInfo(`global ${state.symbol.name}${suffix}`, null, range);
  }

  if (state.kind === "field") {
    const prefix = state.symbol.writable ? "set " : "";
    const suffix = state.symbol.declaredType ? ` ${state.symbol.declaredType}` : "";
    return makeHoverInfo(`${prefix}${state.symbol.name}${suffix}`, null, range);
  }

  return null;
}

function functionParameterLabel(param) {
  return param.type ? `${param.name} ${param.type}` : param.name;
}

function fieldParameterLabel(field) {
  const prefix = field.writable ? "set " : "";
  const suffix = field.declaredType ? ` ${field.declaredType}` : "";
  return `${prefix}${field.name}${suffix}`;
}

function clampActiveParameter(activeParameter, count) {
  if (count <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(activeParameter, count - 1));
}

function makeSignatureHelp(label, parameterLabels, activeParameter) {
  return {
    signatures: [
      {
        label,
        parameters: parameterLabels.map((item) => ({ label: item }))
      }
    ],
    activeSignature: 0,
    activeParameter: clampActiveParameter(activeParameter, parameterLabels.length)
  };
}

function signatureHelpForState(state, activeParameter) {
  if (!state) {
    return null;
  }

  if (state.kind === "function" || state.kind === "method") {
    const labels = state.symbol.params.map((param) => functionParameterLabel(param));
    return makeSignatureHelp(formatFunctionDetail(state.symbol), labels, activeParameter);
  }

  if (state.kind === "struct") {
    const labels = state.symbol.fields.map((field) => fieldParameterLabel(field));
    const params = labels.join(", ");
    return makeSignatureHelp(`${state.symbol.name}(${params})`, labels, activeParameter);
  }

  return null;
}

function advanceDefinitionState(state, segment, context) {
  let current = state;

  if (current.kind === "value") {
    const resolved = resolveTypeTarget(current.typeText, context);
    if (!resolved) {
      return null;
    }
    current = resolved;
  }

  if (current.kind === "module") {
    const definition = resolveTopLevelDefinition(current.moduleIndex, segment);
    if (!definition) {
      return null;
    }
    if (definition.kind === "struct") {
      return {
        kind: "struct",
        symbol: definition.symbol,
        moduleIndex: current.moduleIndex,
        moduleAlias: current.alias
      };
    }
    if (definition.kind === "function") {
      return {
        kind: "function",
        symbol: definition.symbol,
        moduleIndex: current.moduleIndex
      };
    }
    if (definition.kind === "global") {
      return {
        kind: "global",
        symbol: definition.symbol,
        moduleIndex: current.moduleIndex
      };
    }
    if (definition.kind === "trait") {
      return {
        kind: "trait",
        symbol: definition.symbol,
        moduleIndex: current.moduleIndex
      };
    }
    return {
      kind: "import",
      symbol: definition.symbol,
      moduleIndex: current.moduleIndex
    };
  }

  if (current.kind === "builtin" || current.kind === "tuple") {
    return null;
  }

  if (current.kind === "struct") {
    const field = current.struct ? current.struct.fields.find((candidate) => candidate.name === segment) : current.symbol.fields.find((candidate) => candidate.name === segment);
    if (field) {
      return {
        kind: "field",
        symbol: field,
        moduleIndex: current.moduleIndex
      };
    }
    const method = current.struct ? current.struct.methods.find((candidate) => candidate.name === segment) : current.symbol.methods.find((candidate) => candidate.name === segment);
    if (method) {
      return {
        kind: "method",
        symbol: method,
        moduleIndex: current.moduleIndex
      };
    }
    return null;
  }

  if (current.kind === "trait") {
    const method = current.trait ? current.trait.methods.find((candidate) => candidate.name === segment) : current.symbol.methods.find((candidate) => candidate.name === segment);
    if (method) {
      return {
        kind: "method",
        symbol: method,
        moduleIndex: current.moduleIndex
      };
    }
    return null;
  }

  return null;
}

function stateForContinuation(state, context) {
  if (!state) {
    return null;
  }
  if (state.kind === "field") {
    return {
      kind: "value",
      symbol: state.symbol,
      moduleIndex: state.moduleIndex,
      typeText: state.symbol.declaredType || null
    };
  }
  if (state.kind === "global") {
    return {
      kind: "value",
      symbol: state.symbol,
      moduleIndex: state.moduleIndex,
      typeText: state.symbol.declaredType || null
    };
  }
  if (state.kind === "method" || state.kind === "function") {
    return {
      kind: "value",
      symbol: state.symbol,
      moduleIndex: state.moduleIndex,
      typeText: state.symbol.returnType || null
    };
  }
  return state;
}

function buildDefinitionContext(documentIndex, offset, resolveModuleIndex) {
  const currentFunction = findInnermostFunction(documentIndex, offset);
  let visibleSymbols;
  if (currentFunction && currentFunction.bodyRange) {
    const initialSymbols = currentFunction.params.map((param) => ({
      name: param.name,
      type: param.type,
      kind: "parameter",
      range: param.range
    }));
    if (currentFunction.ownerStruct) {
      const ownerStruct = documentIndex.structs.get(currentFunction.ownerStruct);
      initialSymbols.push({
        name: "self",
        type: currentFunction.ownerStruct,
        kind: "parameter",
        range: ownerStruct ? ownerStruct.range : currentFunction.range
      });
    }
    visibleSymbols = collectBindingsBeforeOffset(documentIndex, offset, {
      startIndex: currentFunction.bodyRange.openIndex + 1,
      endOffset: offset,
      initialSymbols,
      resolveModuleIndex
    });
  } else {
    visibleSymbols = collectBindingsBeforeOffset(documentIndex, offset, {
      startIndex: 0,
      endOffset: offset,
      skipRanges: documentIndex.skipRanges,
      resolveModuleIndex
    });
  }
  return {
    currentIndex: documentIndex,
    visibleSymbols,
    resolveModuleIndex
  };
}

function findDefinitionLocation(documentIndex, offset, resolveModuleIndex) {
  const reference = getReferenceContext(documentIndex, offset);
  if (!reference || reference.segments.length === 0) {
    return null;
  }

  const context = buildDefinitionContext(documentIndex, offset, resolveModuleIndex);
  let state = resolveRootState(reference.segments[0], context);
  if (!state) {
    return null;
  }
  if (reference.targetSegmentIndex === 0) {
    return definitionLocationForState(state, documentIndex);
  }

  for (let index = 1; index < reference.segments.length; index += 1) {
    state = advanceDefinitionState(stateForContinuation(state, context), reference.segments[index], context);
    if (!state) {
      return null;
    }
    if (index === reference.targetSegmentIndex) {
      return definitionLocationForState(state, documentIndex);
    }
  }

  return null;
}

function findHoverInfo(documentIndex, offset, resolveModuleIndex) {
  const reference = getReferenceContext(documentIndex, offset);
  if (!reference || reference.segments.length === 0) {
    return null;
  }

  const context = buildDefinitionContext(documentIndex, offset, resolveModuleIndex);
  let state = resolveRootState(reference.segments[0], context);
  if (!state) {
    return null;
  }
  if (reference.targetSegmentIndex === 0) {
    return hoverInfoForState(state, documentIndex);
  }

  for (let index = 1; index < reference.segments.length; index += 1) {
    state = advanceDefinitionState(stateForContinuation(state, context), reference.segments[index], context);
    if (!state) {
      return null;
    }
    if (index === reference.targetSegmentIndex) {
      return hoverInfoForState(state, documentIndex);
    }
  }

  return null;
}

function findSignatureHelp(documentIndex, offset, resolveModuleIndex) {
  const signatureContext = getSignatureContext(documentIndex, offset);
  if (!signatureContext || signatureContext.segments.length === 0) {
    return null;
  }

  const context = buildDefinitionContext(documentIndex, offset, resolveModuleIndex);
  let state = resolveRootState(signatureContext.segments[0], context);
  if (!state) {
    return null;
  }

  for (let index = 1; index < signatureContext.segments.length; index += 1) {
    state = advanceDefinitionState(stateForContinuation(state, context), signatureContext.segments[index], context);
    if (!state) {
      return null;
    }
  }

  return signatureHelpForState(state, signatureContext.activeParameter);
}

function resolveImportPath(currentFilePath, importPath, includeDirectories) {
  if (!currentFilePath) {
    return null;
  }
  let target = importPath;
  if (!path.extname(target)) {
    target += ".lo";
  }
  if (path.isAbsolute(target)) {
    return path.normalize(target);
  }
  const searchRoots = [path.dirname(currentFilePath), ...includeDirectories];
  let fallback = null;
  for (const root of searchRoots) {
    const candidate = path.normalize(path.join(root, target));
    fallback = fallback || candidate;
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return fallback;
}

module.exports = {
  BUILTIN_TYPES,
  COMPLETION_ITEM_KIND,
  buildCompletionItems,
  buildDocumentIndex,
  findDefinitionLocation,
  findHoverInfo,
  findSignatureHelp,
  getReferenceContext,
  getCompletionContext,
  getSignatureContext,
  normalizeTypeText,
  offsetToPosition,
  positionToOffset,
  resolveImportPath,
  tokenize
};
