async function main() {
  const asmText = trimSub(await Deno.readTextFile("MS-DOS/v1.25/source/ASM.ASM"));
  const tokens = tokenize(asmText);
  const origLines = parseLines(tokens);
  const [lines, consts] = extractConstants(origLines);
  const [instructions, labels, inverseLabels] = analyzeLabels(lines);
  const writesFrom = analyzeWrites(instructions);

  let cText = "";
  for (const constDecl of consts.values()) {
    for (const leadingComment of constDecl.leadingComments) {
      cText += `// ${leadingComment}\n`;
    }
    cText += `const int ${constDecl.name} = ${stringifyOperandAsC(constDecl.value)};`;
    if (constDecl.trailingComments.length > 0) {
      cText += " //";
      for (const trailingComment of constDecl.trailingComments) {
        cText += ` ${trailingComment}`;
      }
    }
    cText += "\n";
  }
  cText += "int main() {\n";
  for (let i = 0; i < instructions.length; i++) {
    for (const label of inverseLabels.get(i) || []) {
      for (const leadingComment of label.leadingComments) {
        cText += `  // ${leadingComment}\n`;
      }
      cText += `${label.name}:`;
      if (label.trailingComments.length > 0) {
        cText += " //";
        for (const trailingComment of label.trailingComments) {
          cText += ` ${trailingComment}`;
        }
      }
      cText += "\n";
    }
    const instruction = instructions[i];
    for (const leadingComment of instruction.leadingComments) {
      cText += `  // ${leadingComment}\n`;
    }
    cText += `  // writes: ${Deno.inspect(writesFrom[i].writes).replace(/\n/g, "\n  //         ")}\n`;
    cText += `  asm("${escapeC(stringifyInstruction(instruction))}");`;
    if (instruction.trailingComments.length > 0) {
      cText += " //";
      for (const trailingComment of instruction.trailingComments) {
        cText += ` ${trailingComment}`;
      }
    }
    cText += "\n";
  }
  cText += "}\n";
  await Deno.writeTextFile("asm.c", cText);
}

type Token = {
  text: string;
  line: number;
  leadingComments: string[];
  trailingComments: string[];
};

function trimSub(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/\x1A.*/g, "");
}

function tokenize(text: string) {
  let i = 0;
  let line = 0;
  const tokens: Token[] = [];
  let tokenInLine: Token | null = null;
  let pendingComments: string[] = [];
  function pushToken(start: number) {
    const token: Token = {
      text: text.slice(start, i),
      line,
      leadingComments: pendingComments,
      trailingComments: [],
    };
    pendingComments = [];
    tokens.push(token);
    tokenInLine = token;
  }
  while (i < text.length) {
    if (/[ \t]/.test(text[i])) {
      i++;
      continue;
    }
    const start = i;
    if (text[i] === ";") {
      while (i < text.length && text[i] !== "\n") {
        i++;
      }
      const comment = text.slice(start + 1, i).trim();
      if (tokenInLine) {
        (tokenInLine as Token).trailingComments.push(comment);
      } else {
        pendingComments.push(comment);
      }
    } else if (text[i] === "\n") {
      if (tokenInLine) {
        tokenInLine = null;
        tokens.push({
          text: "\n",
          line,
          leadingComments: [],
          trailingComments: [],
        });
      }
      line++;
      i++;
    } else if (/[a-zA-Z0-9]/.test(text[i])) {
      while (i < text.length && /[a-zA-Z0-9_]/.test(text[i])) {
        i++;
      }
      pushToken(start);
    } else if (/["']/.test(text[i])) {
      const delim = text[i];
      i++;
      while (i < text.length && text[i] !== delim && text[i] !== "\n") {
        i++;
      }
      i++;
      pushToken(start);
    } else {
      i++;
      pushToken(start);
    }
  }
  return tokens;
}

type Label = {
  type: "Label";
  name: string;
  line: number;
  leadingComments: string[];
  trailingComments: string[];
};

type Instruction = {
  type: "Instruction";
  mnemonic: string;
  operands: Operand[];
  line: number;
  leadingComments: string[];
  trailingComments: string[];
};

type Operand = SimpleOperand | IndirectOperand | BinOpOperand | UnOpOperand;
type SimpleOperand = {
  type: "SimpleOperand";
  value: string;
};
type IndirectOperand = {
  type: "IndirectOperand";
  address: Operand;
};
type BinOpOperand = {
  type: "BinOpOperand";
  op: string;
  lhs: Operand;
  rhs: Operand;
};
type UnOpOperand = {
  type: "UnOpOperand";
  op: string;
  arg: Operand;
};

function parseLines(tokens: Token[]): (Label | Instruction)[] {
  const lines: (Label | Instruction)[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (i + 1 < tokens.length && /^[a-zA-Z]/.test(tokens[i].text) && tokens[i + 1].text === ":") {
      lines.push({
        type: "Label",
        name: tokens[i].text,
        line: tokens[i].line,
        leadingComments: tokens[i].leadingComments,
        trailingComments: tokens[i + 1].trailingComments,
      });
      i += 2;
      continue;
    } else if (i + 1 < tokens.length && /^[a-zA-Z]/.test(tokens[i].text) && /^(equ|db|dw|ds|dm)$/i.test(tokens[i + 1].text)) {
      // Special case for `FOO EQU 42`
      lines.push({
        type: "Label",
        name: tokens[i].text,
        line: tokens[i].line,
        leadingComments: tokens[i].leadingComments,
        trailingComments: tokens[i].trailingComments,
      });
      i += 1;
      continue;
    } else if (/^[a-zA-Z]/.test(tokens[i].text)) {
      const mnemonicToken = tokens[i];
      i++;
      const operands: Operand[] = [];
      while (i < tokens.length && tokens[i].text !== "\n") {
        const operand = parseOperand2();
        operands.push(operand);
        if (i < tokens.length && tokens[i].text === ",") {
          i++;
        } else {
          break;
        }
      }
      lines.push({
        type: "Instruction",
        mnemonic: mnemonicToken.text.toLowerCase(),
        operands,
        line: mnemonicToken.line,
        leadingComments: mnemonicToken.leadingComments,
        trailingComments: tokens[i - 1].trailingComments,
      });
    } else if (tokens[i].text === "\n") {
      i++;
    } else {
      // garbage
      lines.push({
        type: "Instruction",
        mnemonic: "garbage:" + tokens[i].text,
        operands: [],
        line: tokens[i].line,
        leadingComments: tokens[i].leadingComments,
        trailingComments: tokens[i].trailingComments,
      });
      i++;
    }
  }
  function parseOperand2(): Operand {
    let operand = parseOperand1();
    while (i < tokens.length && tokens[i].text === "+" || tokens[i].text === "-") {
      const op = tokens[i].text;
      i++;
      const rhs = parseOperand1();
      operand = {
        type: "BinOpOperand",
        op,
        lhs: operand,
        rhs,
      };
    }
    return operand;
  }
  function parseOperand1(): Operand {
    if (i >= tokens.length) {
      return {
        type: "SimpleOperand",
        value: "garbage:EOL",
      };
    }
    const token = tokens[i];
    if (token.text === "[") {
      i++;
      const address = parseOperand2();
      if (i >= tokens.length) {
        return {
          type: "SimpleOperand",
          value: "garbage:[EOL",
        };
      } else if (tokens[i].text !== "]") {
        return {
          type: "SimpleOperand",
          value: "garbage:[" + tokens[i].text,
        };
      }
      i++;
      return {
        type: "IndirectOperand",
        address,
      };
    } else if (/^[+\-]$/.test(token.text)) {
      i++;
      const arg = parseOperand1();
      return {
        type: "UnOpOperand",
        op: token.text,
        arg,
      };
    } else if (/^[0-9a-zA-Z'"$]/.test(token.text)) {
      i++;
      return {
        type: "SimpleOperand",
        value: token.text,
      };
    } else {
      i++;
      return {
        type: "SimpleOperand",
        value: "garbage:" + token.text,
      };
    }
  }

  return lines;
}

function stringifyInstruction(instruction: Instruction): string {
  let text = instruction.mnemonic;
  if (instruction.operands.length > 0) {
    text += " ";
    text += instruction.operands.map((operand) => stringifyOperand(operand)).join(", ");
  }
  return text;
}

function stringifyOperand(operand: Operand, level = 2): string {
  let innerLevel = 0;
  switch (operand.type) {
    case "SimpleOperand":
    case "IndirectOperand":
      innerLevel = 1;
      break;
    case "BinOpOperand":
      innerLevel = 2;
      break;
    case "UnOpOperand":
      innerLevel = 1;
      break;
  }
  if (innerLevel <= level) {
    return stringifyOperandNoParen(operand);
  } else {
    return `(${stringifyOperandNoParen(operand)})`;
  }
}
function stringifyOperandNoParen(operand: Operand): string {
  switch (operand.type) {
    case "SimpleOperand":
      return operand.value;
    case "IndirectOperand":
      return `[${stringifyOperand(operand.address, 2)}]`;
    case "BinOpOperand":
      return `${stringifyOperand(operand.lhs, 2)} ${operand.op} ${stringifyOperand(operand.rhs, 1)}`;
    case "UnOpOperand":
      return `${operand.op}${stringifyOperand(operand.arg, 2)}`;
  }
}

type Constant = {
  name: string;
  value: Operand;
  line: number;
  leadingComments: string[];
  trailingComments: string[];
};

function extractConstants(lines: (Label | Instruction)[]): [(Label | Instruction)[], Map<string, Constant>] {
  const newLines: (Label | Instruction)[] = [];
  const consts: Map<string, Constant> = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === "Label" && i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      if (nextLine.type === "Instruction" && /^equ$/i.test(nextLine.mnemonic) && nextLine.operands.length > 0) {
        consts.set(line.name, {
          name: line.name,
          value: nextLine.operands[0],
          line: nextLine.line,
          leadingComments: [...line.leadingComments, ...nextLine.leadingComments],
          trailingComments: [...line.trailingComments, ...nextLine.trailingComments],
        });
        i++;
        continue;
      }
    }
    newLines.push(line);
  }
  return [newLines, consts];
}

function stringifyOperandAsC(operand: Operand, level = 2): string {
  const [body, innerLevel] = stringifyOperandAsCNoParen(operand);
  if (innerLevel <= level) {
    return body;
  } else {
    return `(${body})`;
  }
}
function stringifyOperandAsCNoParen(operand: Operand): [string, number] {
  switch (operand.type) {
    case "SimpleOperand":
      if (/^[A-Za-z]/.test(operand.value)) {
        return [operand.value, 1];
      } else if (/^[0-9]+$/.test(operand.value)) {
        return [operand.value.replace(/^0+(?=[1-9])/, ""), 1];
      } else if (/^[0-9A-F]+H$/i.test(operand.value)) {
        return [`0x${operand.value.slice(0, operand.value.length - 1)}`, 1];
      } else {
        return [`asm("${escapeC(operand.value)}")`, 1];
      }
    case "IndirectOperand":
      return [`[${stringifyOperandAsC(operand, 2)}]`, 1];
    case "BinOpOperand":
      return [`${stringifyOperandAsC(operand.lhs, 2)} ${operand.op} ${stringifyOperandAsC(operand.rhs, 1)}`, 2];
    case "UnOpOperand":
      return [`${operand.op}${stringifyOperandAsC(operand.arg, 2)}`, 2];
  }
}

function analyzeLabels(lines: (Label | Instruction)[]): [Instruction[], Map<string, number>, Map<number, Label[]>] {
  const instructions: Instruction[] = [];
  const labels = new Map<string, number>();
  const inverseLabels = new Map<number, Label[]>();
  const pendingLabels: Label[] = [];
  for (const line of lines) {
    if (line.type === "Label") {
      pendingLabels.push(line);
    } else if (line.type === "Instruction") {
      for (const label of pendingLabels) {
        labels.set(label.name, instructions.length);
      }
      inverseLabels.set(instructions.length, pendingLabels);
      pendingLabels.length = 0;
      instructions.push(line);
    }
  }
  // throw away labels on the last
  return [instructions, labels, inverseLabels];
}

type WriteData = {
  writes: Map<string, StackAlias | string | "any">;
};
type StackAlias = {
  type: "StackAlias";
  index: number;
};

function analyzeWrites(instructions: Instruction[]): WriteData[] {
  const writesFrom: WriteData[] = Array.from({ length: instructions.length }, () => ({ writes: new Map() }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = instructions.length - 1; i >= 0; i--) {
      const instruction = instructions[i];
      const writeData = writesFrom[i];
      const nextWriteData: WriteData = i + 1 < instructions.length ? writesFrom[i + 1] : { writes: new Map() };
      let newWriteData: WriteData | undefined = undefined;
      switch (instruction.mnemonic) {
        case "mov":
        case "xchg":
          break;
        case "push":
          break;
        case "pop":
          break;
        case "ret":
          break;
        case "jp": // Considered an unconditional jump here
        case "jmp":
        case "jmps":
          break;
        case "ja":
        case "jna":
        case "jbe":
        case "jnbe":
        case "jg":
        case "jng":
        case "jle":
        case "jnle":
        case "jge":
        case "jnge":
        case "jl":
        case "jnl":
        case "jo":
        case "jno":
        case "js":
        case "jns":
        case "je":
        case "jne":
        case "jz":
        case "jnz":
        // case "jp":
        case "jnp":
        case "jpe":
        case "jpo":
        case "jae":
        case "jnae":
        case "jb":
        case "jnb":
        case "jc":
        case "jnc":
          break;
        case "call":
          break;
        case "int":
          break;
      }
      if (!newWriteData) {
        const thisInstr: WriteData = {
          writes: new Map(),
        };
        const [, dest] = instructionIO(instruction);
        for (const reg of dest) {
          thisInstr.writes.set(reg, "any");
        }
        newWriteData = composeWrites(thisInstr, nextWriteData);
      }
      changed = updateWrites(writeData, newWriteData) || changed;
    }
  }
  return writesFrom;
}

function composeWrites(write1: WriteData, write2: WriteData): WriteData {
  const newWrites: Map<string, StackAlias | string | "any"> = new Map();
  for (const [key, value2] of write2.writes.entries()) {
    if (value2 === "any") {
      newWrites.set(key, "any");
    } else if (typeof value2 === "string") {
      const value1 = write1.writes.get(value2);
      newWrites.set(key, value1 ?? value2);
    } else if (value2.type === "StackAlias") {
      newWrites.set(key, value2);
    }
  }
  for (const [key, value1] of write1.writes.entries()) {
    if (write2.writes.get(key) === undefined) {
      newWrites.set(key, value1);
    }
  }
  return { writes: newWrites };
}

function updateWrites(writeDataDest: WriteData, writeDataSrc: WriteData): boolean {
  function level(v: StackAlias | string | "any" | undefined): number {
    if (v === "any") {
      return 3;
    } else if (typeof v === "string") {
      return 2;
    } else if (v?.type === "StackAlias") {
      return 2;
    } else {
      return 1;
    }
  }
  let changed = false;
  for (const [key, newValue] of writeDataSrc.writes.entries()) {
    const currentValue = writeDataDest.writes.get(key);
    if (level(newValue) > level(currentValue)) {
      writeDataDest.writes.set(key, newValue);
      changed = true;
    }
  }
  return changed;
}

const REG_NAMES: Set<string> = new Set([
  "al",
  "cl",
  "dl",
  "bl",
  "ah",
  "ch",
  "dh",
  "bh",
  "ax",
  "cx",
  "dx",
  "bx",
  "sp",
  "bp",
  "si",
  "di",
]);
const DEP_EXPAND: Map<string, string[]> = new Map([
  ["ax", ["ah", "al"]],
  ["cx", ["ch", "cl"]],
  ["dx", ["dh", "dl"]],
  ["bx", ["bh", "bl"]],
  ["flags", ["of", "sf", "zf", "af", "pf", "cf"]],
]);

function instructionIO(inst: Instruction): [string[], string[]] {
  const [srcOrig, destOrig] = instructionIOImpl(inst);
  const src: string[] = [];
  for (const s of srcOrig) {
    src.push(...DEP_EXPAND.get(s) || [s]);
  }
  const dest: string[] = [];
  for (const d of destOrig) {
    dest.push(...DEP_EXPAND.get(d) || [d]);
  }
  return [src, dest];
}
function instructionIOImpl(inst: Instruction): [string[], string[]] {
  function dest(inst: Instruction): string[] {
    if (inst.operands.length === 0) {
      return [];
    }
    const reg = asRegister(inst.operands[0]);
    if (reg) {
      return [reg];
    }
    return [];
  }
  function src(inst: Instruction): string[] {
    const deps: Set<string> = new Set();
    for (const op of inst.operands) {
      search(op);
    }
    function search(op: Operand) {
      if (op.type === "SimpleOperand") {
        const reg = asRegister(op);
        if (reg) {
          deps.add(reg);
        }
      } else if (op.type === "IndirectOperand") {
        search(op.address);
      } else if (op.type === "BinOpOperand") {
        search(op.lhs);
        search(op.rhs);
      } else if (op.type === "UnOpOperand") {
        search(op.arg);
      }
    }
    return Array.from(deps.keys());
  }
  function isSelfOp(inst: Instruction): boolean {
    if (inst.operands.length !== 2) {
      return false;
    }
    const [dest, src] = inst.operands;
    return dest.type === "SimpleOperand" && src.type === "SimpleOperand" && dest.value === src.value;
  }
  switch (inst.mnemonic) {
    case "add":
    case "sub":
    case "and":
    case "or":
    case "xor":
    case "neg":
      if (isSelfOp(inst) && (inst.mnemonic === "and" || inst.mnemonic === "or")) {
        return [[...src(inst)], ["flags"]];
      }
      if (isSelfOp(inst) && inst.mnemonic === "xor") {
        return [[], [...dest(inst), "flags"]];
      }
      return [[...src(inst)], [...dest(inst), "flags"]]
    case "adc":
    case "sbb":
      return [[...src(inst), "cf"], [...dest(inst), "flags"]];
    case "cmp":
    case "test":
      return [[...src(inst)], ["flags"]];
    case "not":
      return [[...src(inst)], [...dest(inst)]];
    case "div":
    case "mul": {
      const s = src(inst);
      const d = dest(inst);
      const is16bit = s.some((reg) => ["ax", "cx", "dx", "bx", "sp", "bp", "si", "di"].includes(reg));
      if (inst.mnemonic === "div") {
        if (is16bit) {
          return [[...s, "ax", "dx"], [...d, "ax", "dx", "flags"]];
        } else {
          return [[...s, "al", "ah"], [...d, "al", "ah", "flags"]];
        }
      } else {
        if (is16bit) {
          return [[...s, "ax"], [...d, "ax", "dx", "flags"]];
        } else {
          return [[...s, "al"], [...d, "al", "ah", "flags"]];
        }
      }
    }
    case "aam":
      return [["al"], ["al", "ah", "flags"]];
    case "call":
      // Should be handled by the caller
      return [[], []];
    case "cbw":
      return [["al"], ["al", "ah"]];
    case "cmc":
      return [["cf"], ["cf"]];
    case "cmpb":
      // CMPSB
      return [["si", "di"], ["flags"]];
    case "dec":
    case "inc":
      return [[...src(inst)], [...dest(inst), "of", "sf", "zf", "af", "pf"]];
    case "int":
      // Should be handled by the caller
      return [[], []];
    case "jp": // Considered an unconditional jump here
    case "jmp":
    case "jmps":
      // Should be handled by the caller
      return [[], []];
    case "ja":
    case "jna":
    case "jbe":
    case "jnbe":
      return [["cf", "zf"], []];
    case "jg":
    case "jng":
    case "jle":
    case "jnle":
      return [["of", "sf", "zf"], []];
    case "jge":
    case "jnge":
    case "jl":
    case "jnl":
      return [["of", "sf"], []];
    case "jo":
    case "jno":
      return [["of"], []];
    case "js":
    case "jns":
      return [["sf"], []];
    case "je":
    case "jne":
    case "jz":
    case "jnz":
      return [["zf"], []];
    // case "jp":
    case "jnp":
    case "jpe":
    case "jpo":
      return [["pf"], []];
    case "jae":
    case "jnae":
    case "jb":
    case "jnb":
    case "jc":
    case "jnc":
      return [["cf"], []];
    case "lahf":
      return [["sf", "zf", "af", "pf", "cf"], ["ah"]];
    case "sahf":
      return [["ah"], ["sf", "zf", "af", "pf", "cf"]];
    case "lodb":
      // LODSB
      return [["si"], ["al"]];
    case "lodw":
      // LODSW
      return [["si"], ["ax"]];
    case "loop":
      return [["cx"], ["cx"]];
    case "mov":
      return [[...src(inst)], [...dest(inst), "flags"]]
    case "xchg":
      if (isSelfOp(inst)) {
        // nop
        return [[], []];
      }
      // TODO: special handling for multiple sources
      return [[...src(inst)], [...dest(inst), "flags"]]
    case "movb":
      // MOVSB
      return [["si", "di"], []];
    case "movw":
      // MOVSW
      return [["si", "di"], []];
    case "pop":
      return [["sp"], ["sp", ...dest(inst)]];
    case "push":
      return [["sp", ...src(inst)], ["sp"]];
    case "rcl":
    case "rcr":
      return [[...src(inst), "cf"], [...dest(inst), "cf", "of"]];
    case "rol":
    case "ror":
      return [[...src(inst)], [...dest(inst), "cf", "of"]];
    case "rep":
    case "repe":
    case "repne":
    case "repnz":
      // TODO
      return [[], []];
    case "ret":
      return [["sp"], ["sp"]];
    case "scab":
    case "scasb":
      // SCASB
      return [["al", "di"], ["flags"]];
    case "shl":
    case "shr":
      return [[...src(inst)], [...dest(inst), "flags"]];
    case "stc":
    case "clc":
      return [[], ["cf"]];
    case "cld":
    case "std":
    case "down":
    case "up":
      // UP = CLD
      // DOWN = STD
      return [[], ["cd"]];
    case "stob":
      // STOSB
      return [["al", "di"], []];
    case "stow":
      // STOSW
      return [["ax", "di"], []];
    case "xlat":
      return [["al", "bx"], ["al"]];
    case "align":
    case "db":
    case "dw":
    case "ds":
    case "dm":
    case "equ":
    case "org":
    case "put":
      return [[], []];
    default:
      console.log("analyzeWrites: Unknown mnemonic", inst.mnemonic);
      return [[], []];
  }
}
function asRegister(operand: Operand): string | undefined {
  if (operand.type === "SimpleOperand") {
    const reg = operand.value.toLowerCase();
    if (REG_NAMES.has(reg)) {
      return reg;
    }
  }
  return undefined;
}

const C_ESCAPE_MAP: Record<string, string> = {
  "\0": "\\0",
  "\t": "\\t",
  "\n": "\\n",
  "\r": "\\r",
  "\f": "\\f",
  "\b": "\\b",
  "\\": "\\\\",
  "\"": "\\\"",
};

function escapeC(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/[\x00-\x1F\x7F"]/g, (c) => {
    return C_ESCAPE_MAP[c] || `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

if (import.meta.main) {
  await main();
}
