async function main() {
  const asmText = trimSub(await Deno.readTextFile("MS-DOS/v1.25/source/ASM.ASM"));
  const tokens = tokenize(asmText);
  const origLines = parseLines(tokens);
  const [lines, consts] = extractConstants(origLines);
  const [instructions, labels, inverseLabels] = analyzeLabels(lines);
  const writesFrom = analyzeWrites(instructions, labels);
  const functionEntries = markFunctions(instructions, labels, inverseLabels, writesFrom);
  const { instructionLiveness: livenessTable, functionReturns } = analyzeLiveness(instructions, labels, writesFrom);

  let cText = "";
  for (const constDecl of consts.values()) {
    for (const leadingComment of constDecl.lineMetadata.leadingComments) {
      cText += `// ${leadingComment}\n`;
    }
    cText += `const int ${constDecl.name} = ${stringifyOperandAsC(constDecl.value)};`;
    if (constDecl.lineMetadata.trailingComments.length > 0) {
      cText += " //";
      for (const trailingComment of constDecl.lineMetadata.trailingComments) {
        cText += ` ${trailingComment}`;
      }
    }
    cText += "\n";
  }
  cText += "int main() {\n";
  for (let i = 0; i < instructions.length; i++) {
    if (functionEntries.has(i)) {
      cText += `// function\n`;
    }
    if (functionReturns.has(i)) {
      cText += `// returns: ${Array.from(functionReturns.get(i)!).join(", ")}\n`;
    }
    for (const label of inverseLabels.get(i) || []) {
      for (const leadingComment of label.lineMetadata.leadingComments) {
        cText += `  // ${leadingComment}\n`;
      }
      cText += `${label.name}:`;
      if (label.lineMetadata.trailingComments.length > 0) {
        cText += " //";
        for (const trailingComment of label.lineMetadata.trailingComments) {
          cText += ` ${trailingComment}`;
        }
      }
      cText += "\n";
    }
    const instruction = instructions[i];
    for (const leadingComment of instruction.lineMetadata.leadingComments) {
      cText += `  // ${leadingComment}\n`;
    }
    cText += `  // writes: ${inspectWrites(writesFrom[i])}\n`;
    cText += `  // liveness: ${Array.from(livenessTable[i].liveBefore).join(", ")}\n`;
    cText += `  asm("${escapeC(stringifyInstruction(instruction))}");`;
    if (instruction.lineMetadata.trailingComments.length > 0) {
      cText += " //";
      for (const trailingComment of instruction.lineMetadata.trailingComments) {
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

type LineMetadata = {
  line: number;
  leadingComments: string[];
  trailingComments: string[];
};

type Label = {
  type: "Label";
  name: string;
  lineMetadata: LineMetadata;
};

type Instruction = GenericInstruction | MovInstruction | JmpInstruction | JccInstruction;
type GenericInstruction = {
  type: "Instruction";
  mnemonic: string;
  operands: Operand[];
  lineMetadata: LineMetadata;
};

type Operand = VariableOperand | RegisterOperand | IntegerOperand | StringOperand | IndirectOperand | BinOpOperand | UnOpOperand | GarbageOperand;
type OperandExt = Operand | MemoryOperand;
type VariableOperand = {
  type: "VariableOperand";
  name: string;
};
type RegisterOperand = {
  type: "RegisterOperand";
  reg: string;
};
type IntegerOperand = {
  type: "IntegerOperand";
  digits: string;
  base: number;
};
type StringOperand = {
  type: "StringOperand";
  text: string;
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
type GarbageOperand = {
  type: "GarbageOperand";
  message: string;
};

function parseLines(tokens: Token[]): (Label | Instruction)[] {
  const lines: (Label | Instruction)[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (i + 1 < tokens.length && /^[a-zA-Z]/.test(tokens[i].text) && tokens[i + 1].text === ":") {
      lines.push({
        type: "Label",
        name: tokens[i].text,
        lineMetadata: {
          line: tokens[i].line,
          leadingComments: tokens[i].leadingComments,
          trailingComments: tokens[i + 1].trailingComments,
        }
      });
      i += 2;
      continue;
    } else if (i + 1 < tokens.length && /^[a-zA-Z]/.test(tokens[i].text) && /^(equ|db|dw|ds|dm)$/i.test(tokens[i + 1].text)) {
      // Special case for `FOO EQU 42`
      lines.push({
        type: "Label",
        name: tokens[i].text,
        lineMetadata: {
          line: tokens[i].line,
          leadingComments: tokens[i].leadingComments,
          trailingComments: tokens[i].trailingComments,
        }
      });
      i += 1;
      continue;
    } else if (/^[a-zA-Z]/.test(tokens[i].text)) {
      const genericInstruction = parseGenericInstruction();
      let instruction: Instruction = genericInstruction;
      try {
        instruction = parseStructuredInstruction(genericInstruction);
      } catch (e) {
        if (e instanceof StructuredInstructionParseError) {
          // ignore
        } else {
          throw e;
        }
      }
      lines.push(instruction);
    } else if (tokens[i].text === "\n") {
      i++;
    } else {
      // garbage
      lines.push({
        type: "Instruction",
        mnemonic: "garbage:" + tokens[i].text,
        operands: [],
        lineMetadata: {
          line: tokens[i].line,
          leadingComments: tokens[i].leadingComments,
          trailingComments: tokens[i].trailingComments,
        },
      });
      i++;
    }
  }
  function parseGenericInstruction(): GenericInstruction {
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
    return {
      type: "Instruction",
      mnemonic: mnemonicToken.text.toLowerCase(),
      operands,
      lineMetadata: {
        line: mnemonicToken.line,
        leadingComments: mnemonicToken.leadingComments,
        trailingComments: tokens[i - 1].trailingComments,
      }
    };
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
        type: "GarbageOperand",
        message: "End of line",
      };
    }
    const token = tokens[i];
    if (token.text === "[") {
      i++;
      const address = parseOperand2();
      if (i >= tokens.length) {
        return {
          type: "GarbageOperand",
          message: "Unclosed bracket: EOL",
        };
      } else if (tokens[i].text !== "]") {
        return {
          type: "GarbageOperand",
          message: `Unclosed bracket: found: ${tokens[i].text}`,
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
    } else if (/^[0-9a-zA-Z]/.test(token.text)) {
      i++;
      if (REG_NAMES.has(token.text.toLowerCase())) {
        return {
          type: "RegisterOperand",
          reg: token.text.toLowerCase(),
        };
      } else if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(token.text)) {
        return {
          type: "VariableOperand",
          name: token.text,
        };
      } else if (/^[0-9]+$/.test(token.text)) {
        return {
          type: "IntegerOperand",
          digits: token.text,
          base: 10,
        };
      } else if (/^[0-9][0-9A-F]*H$/i.test(token.text)) {
        return {
          type: "IntegerOperand",
          digits: token.text.slice(0, token.text.length - 1),
          base: 16,
        };
      }
      return {
        type: "GarbageOperand",
        message: `Invalid operand: ${token.text}`,
      };
    } else if (/^'.*'$/.test(token.text)) {
      i++;
      return {
        type: "StringOperand",
        text: token.text.slice(1, token.text.length - 1),
      };
    } else if (/^".*"$/.test(token.text)) {
      i++;
      return {
        type: "StringOperand",
        text: token.text.slice(1, token.text.length - 1),
      };
    } else if (token.text === "$") {
      i++;
      return {
        type: "VariableOperand",
        name: "$",
      };
    } else {
      i++;
      return {
        type: "GarbageOperand",
        message: `Invalid operand: ${token.text}`,
      };
    }
  }

  return lines;
}

type MovInstruction = {
  type: "MovInstruction";
  mnemonic: string;
  dest: RegisterOperand | MemoryOperand;
  src: RegisterOperand | MemoryOperand | ImmediateOperand;
  lineMetadata: LineMetadata;
};
type JmpInstruction = {
  type: "JmpInstruction";
  mnemonic: string;
  target: RegisterOperand | MemoryOperand | ImmediateOperand;
  lineMetadata: LineMetadata;
};
type JccInstruction = {
  type: "JccInstruction";
  mnemonic: string;
  condition: string;
  target: RegisterOperand | MemoryOperand | ImmediateOperand;
  lineMetadata: LineMetadata;
};
type MemoryOperand = {
  type: "MemoryOperand";
  baseReg: string | undefined;
  indexReg: string | undefined;
  // scale: number;
  disp: ImmediateOperand | undefined;
};
type ImmediateOperand = VariableOperand | IntegerOperand | StringOperand | ConstantBinOpOperand | ConstantUnOpOperand;
type ConstantBinOpOperand = {
  type: "BinOpOperand";
  op: string;
  lhs: ImmediateOperand;
  rhs: ImmediateOperand;
};
type ConstantUnOpOperand = {
  type: "UnOpOperand";
  op: string;
  arg: ImmediateOperand;
};

class StructuredInstructionParseError extends Error {
  static {
    this.prototype.name = "StructuredInstructionParseError";
  }
}

const JccMap = {
  // CF
  jc: "c",
  jb: "c",
  jnae: "c",
  // !CF
  jnc: "nc",
  jnb: "nc",
  jae: "nc",
  // CF && ZF
  ja: "a",
  jnbe: "a",
  // !CF || !ZF
  jna: "na",
  jbe: "na",
  // SF ^ OF
  jl: "l",
  jnge: "l",
  // !(SF ^ OF)
  jge: "nl",
  jnl: "nl",
  // (SF ^ OF) || ZF
  jle: "le",
  jng: "le",
  // !(SF ^ OF) && !ZF
  jg: "nle",
  jnle: "nle",
  // ZF
  je: "z",
  jz: "z",
  // !ZF
  jne: "nz",
  jnz: "nz",
  // OF
  jo: "o",
  // !OF
  jno: "no",
  // SF
  js: "s",
  // !SF
  jns: "ns",
  // PF
  jp: "p",
  jpe: "p",
  // !PF
  jnp: "np",
  jpo: "np",
};

function parseStructuredInstruction(instruction: GenericInstruction): Instruction {
  switch (instruction.mnemonic) {
    case "jp": // Considered an unconditional jump here
    case "jmp":
    case "jmps": {
      if (instruction.operands.length !== 1) {
        throw new StructuredInstructionParseError();
      }
      const target = parseRegisterOrMemoryOrImmediateOperand(instruction.operands[0]);
      return {
        type: "JmpInstruction",
        mnemonic: instruction.mnemonic,
        target,
        lineMetadata: instruction.lineMetadata,
      };
    }
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
    // case "jp": // JP means JMP rel8 here rather than JPE
    case "jnp":
    case "jpe":
    case "jpo":
    case "jae":
    case "jnae":
    case "jb":
    case "jnb":
    case "jc":
    case "jnc": {
      if (instruction.operands.length !== 1) {
        throw new StructuredInstructionParseError();
      }
      const condition = JccMap[instruction.mnemonic];
      const target = parseRegisterOrMemoryOrImmediateOperand(instruction.operands[0]);
      return {
        type: "JccInstruction",
        mnemonic: instruction.mnemonic,
        condition,
        target,
        lineMetadata: instruction.lineMetadata,
      };
    }
    case "mov": {
      if (instruction.operands.length !== 2 && instruction.operands.length !== 3) {
        throw new StructuredInstructionParseError();
      }
      const destPos = instruction.operands.length - 2;
      const srcPos = instruction.operands.length - 1;
      // TODO: process operand size
      const dest = parseRegisterOrMemoryOperand(instruction.operands[destPos]);
      const src = parseRegisterOrMemoryOrImmediateOperand(instruction.operands[srcPos]);
      return {
        type: "MovInstruction",
        mnemonic: "mov",
        dest,
        src,
        lineMetadata: instruction.lineMetadata,
      };
    }
  }
  throw new StructuredInstructionParseError();
}
function parseRegisterOrMemoryOperand(operand: Operand): RegisterOperand | MemoryOperand {
  if (operand.type === "RegisterOperand") {
    return operand;
  } else if (operand.type === "IndirectOperand") {
    return parseMemoryOperand(operand);
  }
  throw new StructuredInstructionParseError();
}
function parseRegisterOrMemoryOrImmediateOperand(operand: Operand): RegisterOperand | MemoryOperand | ImmediateOperand {
  if (operand.type === "RegisterOperand") {
    return operand;
  } else if (operand.type === "IndirectOperand") {
    return parseMemoryOperand(operand);
  }
  return parseImmediateOperand(operand);
}
function parseMemoryOperand(operand: Operand): MemoryOperand {
  if (operand.type === "IndirectOperand") {
    return parseMemoryOperandFromAddressPart(operand.address);
  }
  throw new StructuredInstructionParseError();
}
function parseMemoryOperandFromAddressPart(operand: Operand): MemoryOperand {
  switch (operand.type) {
    case "VariableOperand":
    case "IntegerOperand":
    case "StringOperand": {
      return {
        type: "MemoryOperand",
        baseReg: undefined,
        indexReg: undefined,
        disp: operand,
      };
    }
    case "RegisterOperand": {
      if (operand.reg === "bx" || operand.reg === "bp") {
        return {
          type: "MemoryOperand",
          baseReg: operand.reg,
          indexReg: undefined,
          disp: undefined,
        };
      } else if (operand.reg === "si" || operand.reg === "di") {
        return {
          type: "MemoryOperand",
          baseReg: undefined,
          indexReg: operand.reg,
          disp: undefined,
        };
      }
      break;
    }
    case "UnOpOperand": {
      const arg = parseMemoryOperandFromAddressPart(operand.arg);
      if (operand.op === "+") {
        return arg;
      }
      if (arg.baseReg != null || arg.indexReg != null) {
        throw new StructuredInstructionParseError();
      }
      if (arg.disp == null) {
        throw new StructuredInstructionParseError();
      }
      return {
        type: "MemoryOperand",
        baseReg: undefined,
        indexReg: undefined,
        disp: {
          type: "UnOpOperand",
          op: operand.op,
          arg: arg.disp,
        },
      };
    }
    case "BinOpOperand": {
      const lhs = parseMemoryOperandFromAddressPart(operand.lhs);
      const rhs = parseMemoryOperandFromAddressPart(operand.rhs);
      if (
        (lhs.baseReg != null && rhs.baseReg != null) ||
        (lhs.indexReg != null && rhs.indexReg != null)
      ) {
        throw new StructuredInstructionParseError();
      }
      if (operand.op === "-" && (rhs.baseReg != null || lhs.baseReg != null)) {
        throw new StructuredInstructionParseError();
      }
      let disp: ImmediateOperand | undefined;
      if (lhs.disp != null && rhs.disp != null) {
        disp = {
          type: "BinOpOperand",
          op: operand.op,
          lhs: lhs.disp,
          rhs: rhs.disp,
        };
      } else if (lhs.disp != null) {
        disp = lhs.disp;
      } else if (rhs.disp != null) {
        if (operand.op === "-") {
          disp = {
            type: "UnOpOperand",
            op: "-",
            arg: rhs.disp,
          };
        } else {
          disp = rhs.disp;
        }
      } else {
        throw new StructuredInstructionParseError();
      }
      return {
        type: "MemoryOperand",
        baseReg: lhs.baseReg ?? rhs.baseReg,
        indexReg: lhs.indexReg ?? rhs.indexReg,
        disp,
      };
    }
  }
  throw new StructuredInstructionParseError();
}
function parseImmediateOperand(operand: Operand): ImmediateOperand {
  switch (operand.type) {
    case "VariableOperand":
    case "IntegerOperand":
    case "StringOperand":
      return operand;
    case "UnOpOperand":
      return {
        type: "UnOpOperand",
        op: operand.op,
        arg: parseImmediateOperand(operand.arg),
      };
    case "BinOpOperand":
      return {
        type: "BinOpOperand",
        op: operand.op,
        lhs: parseImmediateOperand(operand.lhs),
        rhs: parseImmediateOperand(operand.rhs),
      };
  }
  throw new StructuredInstructionParseError();
}

function stringifyInstruction(instruction: Instruction): string {
  let mnemonic: string;
  let operands: OperandExt[];
  switch (instruction.type) {
    case "Instruction":
      mnemonic = instruction.mnemonic;
      operands = instruction.operands;
      break;
    case "JmpInstruction":
      mnemonic = instruction.mnemonic;
      operands = [instruction.target];
      break;
    case "JccInstruction":
      mnemonic = instruction.mnemonic;
      operands = [instruction.target];
      break;
    case "MovInstruction":
      mnemonic = "mov";
      operands = [instruction.dest, instruction.src];
      break;
  }
  let text = mnemonic;
  if (operands.length > 0) {
    text += " ";
    text += operands.map((operand) => stringifyOperand(operand)).join(", ");
  }
  return text;
}

function stringifyOperand(operand: OperandExt, level = 2): string {
  let innerLevel = 0;
  switch (operand.type) {
    case "VariableOperand":
    case "RegisterOperand":
    case "IntegerOperand":
    case "StringOperand":
    case "IndirectOperand":
    case "MemoryOperand":
      innerLevel = 1;
      break;
    case "BinOpOperand":
      innerLevel = 2;
      break;
    case "UnOpOperand":
      innerLevel = 1;
      break;
    case "GarbageOperand":
      innerLevel = 1;
      break;
  }
  if (innerLevel <= level) {
    return stringifyOperandNoParen(operand);
  } else {
    return `(${stringifyOperandNoParen(operand)})`;
  }
}
function stringifyOperandNoParen(operand: OperandExt): string {
  switch (operand.type) {
    case "VariableOperand":
      return operand.name;
    case "RegisterOperand":
      return operand.reg;
    case "IntegerOperand":
      return operand.base === 16 ? `${operand.digits}H` : operand.digits;
    case "StringOperand":
      if (operand.text.includes('"')) {
        return `'${operand.text}'`;
      } else {
        return `"${operand.text}"`;
      }
    case "IndirectOperand":
      return `[${stringifyOperand(operand.address, 2)}]`;
    case "MemoryOperand": {
      const components: string[] = [];
      if (operand.baseReg) {
        components.push(operand.baseReg);
      }
      if (operand.indexReg) {
        components.push(operand.indexReg);
      }
      if (operand.disp) {
        components.push(stringifyOperand(operand.disp, 1));
      }
      return `[${components.join(" + ")}]`;
    }
    case "BinOpOperand":
      return `${stringifyOperand(operand.lhs, 2)} ${operand.op} ${stringifyOperand(operand.rhs, 1)}`;
    case "UnOpOperand":
      return `${operand.op}${stringifyOperand(operand.arg, 2)}`;
    case "GarbageOperand":
      return `<<GARBAGE: ${operand.message}>>`;
  }
}

type Constant = {
  name: string;
  value: Operand;
  lineMetadata: LineMetadata;
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
          lineMetadata: {
            line: nextLine.lineMetadata.line,
            leadingComments: [...line.lineMetadata.leadingComments, ...nextLine.lineMetadata.leadingComments],
            trailingComments: [...line.lineMetadata.trailingComments, ...nextLine.lineMetadata.trailingComments],
          },
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
    case "VariableOperand":
      if (/^[A-Za-z]/.test(operand.name)) {
        return [operand.name, 1];
      } else {
        return [`asm("${escapeC(operand.name)}")`, 1];
      }
    case "RegisterOperand":
      return [operand.reg, 1];
    case "IntegerOperand":
      return [operand.base === 16 ? `0x${operand.digits}` : operand.digits.replace(/^0+(?=[1-9])/, ""), 1];
    case "StringOperand":
      return [`'${escapeC(operand.text[0])}'`, 1];
    case "IndirectOperand":
      return [`[${stringifyOperandAsC(operand, 2)}]`, 1];
    case "BinOpOperand":
      return [`${stringifyOperandAsC(operand.lhs, 2)} ${operand.op} ${stringifyOperandAsC(operand.rhs, 1)}`, 2];
    case "UnOpOperand":
      return [`${operand.op}${stringifyOperandAsC(operand.arg, 2)}`, 2];
    case "GarbageOperand":
      return [`<<GARBAGE: ${operand.message}>>`, 1];
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
    } else {
      for (const label of pendingLabels) {
        labels.set(label.name, instructions.length);
      }
      inverseLabels.set(instructions.length, [...pendingLabels]);
      pendingLabels.length = 0;
      instructions.push(line);
    }
  }
  // throw away labels on the last
  return [instructions, labels, inverseLabels];
}

type WriteData = {
  writes: Map<string, StackAlias | string | "any">;
  returnsAt: Set<number>;
  sp: number | "any";
};
function emptyWriteData(): WriteData {
  return { writes: new Map(), returnsAt: new Set(), sp: 0 };
}
function retWriteData(at: number): WriteData {
  return { writes: new Map(), returnsAt: new Set([at]), sp: 0 };
}
type StackAlias = {
  type: "StackAlias";
  index: number;
  size: number;
};

function analyzeWrites(instructions: Instruction[], labels: Map<string, number>): WriteData[] {
  const writesFrom: WriteData[] = Array.from({ length: instructions.length }, () => emptyWriteData());
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = instructions.length - 1; i >= 0; i--) {
      const instruction = instructions[i];
      const writeData = writesFrom[i];
      const nextWriteData: WriteData = i + 1 < instructions.length ? writesFrom[i + 1] : emptyWriteData();
      let newWriteData: WriteData | undefined = undefined;
      if (instruction.type === "MovInstruction") {
        const { dest, src } = instruction;
        if (dest.type === "RegisterOperand" && dest.reg === "sp") {
          newWriteData = emptyWriteData();
        }
        if (dest.type === "RegisterOperand" && dest.reg !== "sp" && src.type === "RegisterOperand") {
          const mapping: SeqWritesMapping = {};
          for (const reg of expandAliases(new Set([dest.reg]))) {
            mapping[reg] = "any";
          }
          mapping[dest.reg] = src.reg;
          for (const [key, destSub] of Object.entries(SUB_REGS.get(dest.reg) ?? {})) {
            const srcSub = SUB_REGS.get(src.reg)?.[key];
            if (srcSub) {
              mapping[destSub] = srcSub;
            }
          }
          newWriteData = seqWrites(nextWriteData, mapping);
        }
      } else if (instruction.type === "JmpInstruction") {
        const { target } = instruction;
        if (target.type === "VariableOperand") {
          const targetIndex = labels.get(target.name);
          if (targetIndex !== undefined) {
            newWriteData = writesFrom[targetIndex];
          }
        }
      } else if (instruction.type === "JccInstruction") {
        const { target } = instruction;
        if (target.type === "VariableOperand") {
          const targetIndex = labels.get(target.name);
          if (targetIndex !== undefined) {
            newWriteData = mergeWrites(nextWriteData, writesFrom[targetIndex]);
          }
        }
      } else if (instruction.type === "Instruction") {
        switch (instruction.mnemonic) {
          case "xchg":
            break;
          case "push": {
            const reg = instruction.operands[0] && asRegister(instruction.operands[0]);
            newWriteData = popWrites(nextWriteData, 2, reg);
            break;
          }
          case "pop": {
            const reg = instruction.operands[0] && asRegister(instruction.operands[0]);
            if (reg) {
              newWriteData = seqWrites(pushWrites(nextWriteData, 2), {
                [reg]: {
                  type: "StackAlias",
                  index: 0,
                  size: 2,
                },
              });
            } else {
              newWriteData = pushWrites(nextWriteData, 2);
            }
            break;
          }
          case "ret":
            newWriteData = retWriteData(i);
            break;
          case "call":
            break;
          case "int":
            break;
        }
      }
      if (!newWriteData) {
        const mapping: SeqWritesMapping = {};
        const [, dest] = instructionIO(instruction);
        for (const reg of expandAliases(dest)) {
          mapping[reg] = "any";
        }
        newWriteData = seqWrites(nextWriteData, mapping);
      }
      changed = updateWrites(writeData, newWriteData) || changed;
    }
  }
  return writesFrom;
}

function pushWrites(writeSrc: WriteData, offset: number): WriteData {
  if (writeSrc.returnsAt.size === 0) {
    return emptyWriteData();
  }
  const newWrites: Map<string, StackAlias | string | "any"> = new Map();
  for (const [key, value] of writeSrc.writes.entries()) {
    if (value === "any") {
      newWrites.set(key, "any");
    } else if (typeof value === "string") {
      newWrites.set(key, value);
    } else if (value.type === "StackAlias") {
      newWrites.set(key, {
        type: "StackAlias",
        index: value.index + offset,
        size: value.size,
      });
    }
  }
  const sp = writeSrc.sp === "any" ? "any" : writeSrc.sp + offset;
  return { writes: newWrites, returnsAt: writeSrc.returnsAt, sp };
}

function popWrites(writeSrc: WriteData, offset: number, resultReg: string | undefined): WriteData {
  if (writeSrc.returnsAt.size === 0) {
    return emptyWriteData();
  }
  const newWrites: Map<string, StackAlias | string | "any"> = new Map();
  const restoreList: string[] = [];
  for (const [key, value] of writeSrc.writes.entries()) {
    if (value === "any") {
      newWrites.set(key, "any");
    } else if (typeof value === "string") {
      newWrites.set(key, value);
    } else if (value.type === "StackAlias") {
      if (value.index === 0 && value.size === 2 && resultReg) {
        restoreList.push(key);
      } else if (value.index < offset) {
        newWrites.set(key, "any");
      } else {
        newWrites.set(key, {
          type: "StackAlias",
          index: value.index - offset,
          size: value.size,
        });
      }
    }
  }
  for (const restoreReg of restoreList) {
    newWrites.set(restoreReg, resultReg!);
    const restoreMap = SUB_REGS.get(restoreReg) ?? {};
    const resultMap = SUB_REGS.get(resultReg!) ?? {};
    for (const [key, subRestoreReg] of Object.entries(restoreMap)) {
      const subResultReg = resultMap[key];
      if (subResultReg) {
        newWrites.set(subRestoreReg, subResultReg);
      }
    }
  }
  for (const [key, value] of Array.from(newWrites.entries())) {
    if (key === value) {
      newWrites.delete(key);
    }
  }
  const sp = writeSrc.sp === "any" ? "any" : writeSrc.sp - offset;
  return { writes: newWrites, returnsAt: writeSrc.returnsAt, sp };
}

type SeqWritesMapping = Record<string, string | StackAlias | "any">;
function seqWrites(next: WriteData, mapping: Record<string, string | StackAlias | "any">): WriteData {
  if (next.returnsAt.size === 0) {
    return emptyWriteData();
  }
  const newWrites: Map<string, StackAlias | string | "any"> = new Map();
  for (const [key, value] of next.writes.entries()) {
    if (value === "any") {
      newWrites.set(key, "any");
    } else if (typeof value === "string") {
      newWrites.set(key, mapping[value] ?? value);
    } else if (value.type === "StackAlias") {
      newWrites.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(mapping)) {
    if (!next.writes.has(key)) {
      newWrites.set(key, value);
    }
  }
  return { writes: newWrites, returnsAt: next.returnsAt, sp: next.sp };
}

function mergeWrites(write1: WriteData, write2: WriteData): WriteData {
  if (write1.returnsAt.size === 0) {
    return write2;
  } else if (write2.returnsAt.size === 0) {
    return write1;
  }
  const newWrites: Map<string, StackAlias | string | "any"> = new Map();
  for (const [key, value1] of write1.writes.entries()) {
    newWrites.set(key, value1);
  }
  for (const [key, value2] of write2.writes.entries()) {
    const value1 = newWrites.get(key);
    if (value1 === undefined) {
      newWrites.set(key, value2);
    } else if (typeof value1 === "string" && typeof value2 === "string" && value1 === value2) {
      // do nothing
    } else if (
      typeof value1 === "object" &&
      value1.type === "StackAlias" &&
      typeof value2 === "object" &&
      value2.type === "StackAlias" &&
      value1.index === value2.index &&
      value1.size === value2.size
    ) {
      // do nothing
    } else {
      newWrites.set(key, "any");
    }
  }
  const sp = write1.sp === "any" || write2.sp === "any" ? "any" : write1.sp === write2.sp ? write1.sp : "any";
  return { writes: newWrites, returnsAt: write1.returnsAt.union(write2.returnsAt), sp };
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
  for (const key of writeDataSrc.returnsAt) {
    if (!writeDataDest.returnsAt.has(key)) {
      writeDataDest.returnsAt.add(key);
      changed = true;
    }
  }
  writeDataDest.sp = writeDataSrc.sp;
  return changed;
}

function inspectWrites(writeData: WriteData): string {
  if (writeData.returnsAt.size === 0) {
    return "no return";
  }
  const regs: string[] = Array.from(writeData.writes.keys());
  regs.sort();
  const regEntries: string[] = regs.map((reg) => {
    const value = writeData.writes.get(reg)!;
    if (value === "any") {
      return `${reg}`;
    } else if (typeof value === "string") {
      return `${reg}=${value}`;
    } else if (value.type === "StackAlias") {
      return `${reg}=[sp+${value.index}]`;
    }
    return "";
  });
  return regEntries.join(", ") + ", sp=" + writeData.sp;
}

function markFunctions(instructions: Instruction[], labels: Map<string, number>, inverseLabels: Map<number, Label[]>, writesFrom: WriteData[]): Set<number> {
  const labelGraph: Map<number, number[]> = new Map();
  let lastLabel: number | undefined = undefined;
  for (let i = 0; i < instructions.length; i++) {
    if (inverseLabels.has(i) && inverseLabels.get(i)!.length > 0) {
      if (lastLabel != null) {
        labelGraph.get(lastLabel)!.push(i);
      }
      lastLabel = i;
      labelGraph.set(i, []);
    }
    const instruction = instructions[i];
    if (instruction.type === "MovInstruction") {
      //
    } else if (instruction.type === "JmpInstruction") {
      const { target } = instruction;
      if (target.type === "VariableOperand") {
        const targetIndex = labels.get(target.name);
        if (targetIndex !== undefined) {
          if (lastLabel !== undefined) {
            labelGraph.get(lastLabel)!.push(targetIndex);
          }
        }
      }
      lastLabel = undefined;
    } else if (instruction.type === "JccInstruction") {
      const { target } = instruction;
      if (target.type === "VariableOperand") {
        const targetIndex = labels.get(target.name);
        if (targetIndex !== undefined) {
          if (lastLabel !== undefined) {
            labelGraph.get(lastLabel)!.push(targetIndex);
          }
        }
      }
    } else {
      switch (instruction.mnemonic) {
        case "ret":
          lastLabel = undefined;
          break;
      }
    }
  }

  const functionEntries: Set<number> = new Set();
  for (let i = 0; i < instructions.length; i++) {
    const instruction = instructions[i];
    if (instruction.type === "Instruction" && instruction.mnemonic === "call" && instruction.operands.length === 1) {
      const target = instruction.operands[0];
      if (target.type === "VariableOperand") {
        const targetIndex = labels.get(target.name);
        if (targetIndex !== undefined) {
          functionEntries.add(targetIndex);
        }
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;

    const visited: Set<number> = new Set();
    const owned: Set<number> = new Set();
    for (const functionEntry of Array.from(functionEntries)) {
      visited.clear();
      search(functionEntry, functionEntry);
    }
    // deno-lint-ignore no-inner-declarations
    function search(v: number, owner: number) {
      if (v !== owner && functionEntries.has(v)) {
        return;
      }
      if (visited.has(v)) {
        return;
      }
      visited.add(v);
      const sp = writesFrom[v].sp;
      const entryEligible = sp === "any" || sp === 0;
      if (entryEligible) {
        if (owned.has(v) && !functionEntries.has(v)) {
          functionEntries.add(v);
          changed = true;
          return;
        }
        owned.add(v);
      }
      for (const u of labelGraph.get(v) ?? []) {
        search(u, owner);
      }
    }
  }
  return functionEntries;
}

type LivenessResult = {
  instructionLiveness: InstructionLiveness[];
  functionReturns: Map<number, Set<string>>;
};
type InstructionLiveness = {
  liveBefore: Set<string>;
};

function analyzeLiveness(instructions: Instruction[], labels: Map<string, number>, writesFrom: WriteData[]): LivenessResult {
  const functionEntries: Set<number> = new Set();
  const returnOriginMap: Map<number, number[]> = new Map();
  const callOriginMap: Map<number, number[]> = new Map();
  {
    // deno-lint-ignore no-inner-declarations
    function processCall(i: number) {
      if (functionEntries.has(i)) {
        return;
      }
      functionEntries.add(i);
      const returns = writesFrom[i].returnsAt;
      for (const ret of returns) {
        if (returnOriginMap.has(ret)) {
          returnOriginMap.get(ret)!.push(i);
        } else {
          returnOriginMap.set(ret, [i]);
        }
      }
    }
    for (let i = 0; i < instructions.length; i++) {
      const instruction = instructions[i];
      if (instruction.type === "Instruction" && instruction.mnemonic === "call" && instruction.operands.length === 1) {
        const target = instruction.operands[0];
        if (target.type === "VariableOperand") {
          const targetIndex = labels.get(target.name);
          if (targetIndex !== undefined) {
            processCall(targetIndex);
            if (callOriginMap.has(targetIndex)) {
              callOriginMap.get(targetIndex)!.push(i);
            } else {
              callOriginMap.set(targetIndex, [i]);
            }
          }
        }
      }
    }
  }
  const livenessTable: InstructionLiveness[] = Array.from({ length: instructions.length }, () => ({ liveBefore: new Set() }));

  function computeFunctionReturns(): Map<number, Set<string>> {
    const functionReturns: Map<number, Set<string>> = new Map();
    for (const functionEntry of functionEntries) {
      const returnedRegs: Set<string> = new Set();
      const functionWrites = writesFrom[functionEntry].writes;
      for (const callIndex of callOriginMap.get(functionEntry) ?? []) {
        const innerLiveness = livenessTable[callIndex + 1].liveBefore;
        for (const reg of innerLiveness) {
          if (functionWrites.has(reg)) {
            returnedRegs.add(reg);
          }
        }
      }
      functionReturns.set(functionEntry, returnedRegs);
    }
    return functionReturns;
  }

  let changed = true;
  while (changed) {
    changed = false;
    const functionReturns = computeFunctionReturns();
    for (let i = instructions.length - 1; i >= 0; i--) {
      const instruction = instructions[i];
      const livenessHere = livenessTable[i];
      const livenessNext: InstructionLiveness = i + 1 < instructions.length ? livenessTable[i + 1] : { liveBefore: new Set() };
      let newLiveness: InstructionLiveness | undefined = undefined;
      if (instruction.type === "MovInstruction") {
        //
      } else if (instruction.type === "JmpInstruction") {
        const { target } = instruction;
        if (target.type === "VariableOperand") {
          const targetIndex = labels.get(target.name);
          if (targetIndex !== undefined) {
            if (instruction.mnemonic === "call") {
              const functionWrites = new Set(writesFrom[targetIndex].writes.keys());
              const preservedRegs = livenessNext.liveBefore.difference(functionWrites);
              newLiveness = { liveBefore: livenessTable[targetIndex].liveBefore.union(preservedRegs) };
            } else {
              newLiveness = { liveBefore: livenessTable[targetIndex].liveBefore };
            }
          }
        }
      } else if (instruction.type === "JccInstruction") {
        newLiveness = { liveBefore: new Set(livenessNext.liveBefore) };
        // Check condition flags
        const [src] = instructionIO(instruction);
        for (const reg of src) {
          newLiveness.liveBefore.add(reg);
        }

        const { target } = instruction;
        if (target.type === "VariableOperand") {
          const targetIndex = labels.get(target.name);
          if (targetIndex !== undefined) {
            for (const reg of livenessTable[targetIndex].liveBefore) {
              newLiveness.liveBefore.add(reg);
            }
          } else if (/^ret$/i.test(target.name)) {
            // Jcc RET ... specially handled by ASM
            // TODO: integrate logic with RET
            for (const functionEntry of returnOriginMap.get(i) ?? []) {
              const functionWrites = new Set(writesFrom[functionEntry].writes.keys());
              for (const callIndex of callOriginMap.get(functionEntry) ?? []) {
                if (callIndex + 1 >= instructions.length) {
                  continue;
                }
                const innerLiveness = livenessTable[callIndex + 1].liveBefore.intersection(functionWrites);
                for (const reg of innerLiveness) {
                  newLiveness.liveBefore.add(reg);
                }
              }
            }
          }
        }
      } else if (instruction.type === "Instruction") {
        switch (instruction.mnemonic) {
          // case "xchg":
          //   break;
          // case "push": {
          //   const reg = instruction.operands[0] && asRegister(instruction.operands[0]);
          //   newWriteData = popWrites(nextWriteData, 2, reg);
          //   break;
          // }
          // case "pop": {
          //   const reg = instruction.operands[0] && asRegister(instruction.operands[0]);
          //   if (reg) {
          //     newWriteData = pushWrites(nextWriteData, 2, {
          //       [reg]: {
          //         type: "StackAlias",
          //         index: 0,
          //         size: 2,
          //       },
          //     });
          //   } else {
          //     newWriteData = pushWrites(nextWriteData, 2, {});
          //   }
          //   break;
          // }
          case "ret":
            newLiveness = { liveBefore: new Set() };
            for (const functionEntry of returnOriginMap.get(i) ?? []) {
              const returnedRegs = functionReturns.get(functionEntry)!;
              for (const reg of returnedRegs) {
                newLiveness.liveBefore.add(reg);
              }
            }
            break;
          case "call":
            // Same as JMP
            if (instruction.operands.length === 1) {
              const target = instruction.operands[0];
              if (target.type === "VariableOperand") {
                const targetIndex = labels.get(target.name);
                if (targetIndex !== undefined) {
                  if (instruction.mnemonic === "call") {
                    const functionWrites = new Set(writesFrom[targetIndex].writes.keys());
                    const preservedRegs = livenessNext.liveBefore.difference(functionWrites);
                    newLiveness = { liveBefore: livenessTable[targetIndex].liveBefore.union(preservedRegs) };
                  } else {
                    newLiveness = { liveBefore: livenessTable[targetIndex].liveBefore };
                  }
                }
              }
            }
            break;
          // case "int":
          //   break;
        }
      }
      if (!newLiveness) {
        newLiveness = { liveBefore: decomposeCoverings(livenessNext.liveBefore) };
        const [src, dest] = instructionIO(instruction);
        for (const reg of expandCoverings(dest)) {
          newLiveness.liveBefore.delete(reg);
        }
        for (const reg of src) {
          newLiveness.liveBefore.add(reg);
        }
      }
      for (const reg of newLiveness.liveBefore) {
        if (!livenessHere.liveBefore.has(reg)) {
          livenessHere.liveBefore.add(reg);
          changed = true;
        }
      }
    }
  }
  return {
    instructionLiveness: livenessTable,
    functionReturns: computeFunctionReturns(),
  };
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
const SUB_REGS: Map<string, Record<string, string>> = new Map<string, Record<string, string>>([
  ["ax", { highByte: "ah", byte: "al" }],
  ["cx", { highByte: "ch", byte: "cl" }],
  ["dx", { highByte: "dh", byte: "dl" }],
  ["bx", { highByte: "bh", byte: "bl" }],
  ["hflags", { bit7: "sf", bit6: "zf", bit4: "af", bit2: "pf", bit0: "cf" }],
  ["flags", { bit11: "of", bit10: "df", bit9: "if", bit8: "tf", bit7: "sf", bit6: "zf", bit4: "af", bit2: "pf", bit0: "cf" }],
]);
const SUPER_REGS: Map<string, string[]> = new Map();
for (const [key, value] of SUB_REGS) {
  for (const sub of Object.values(value)) {
    if (SUPER_REGS.has(sub)) {
      SUPER_REGS.get(sub)!.push(key);
    } else {
      SUPER_REGS.set(sub, [key]);
    }
  }
}
const REG_COVERINGS: [string, string[]][] = [
  ["ax", ["ah", "al"]],
  ["cx", ["ch", "cl"]],
  ["dx", ["dh", "dl"]],
  ["bx", ["bh", "bl"]],
];

function expandSubRegs(regs: Set<string>): Set<string> {
  const result: Set<string> = new Set();
  for (const r of regs) {
    result.add(r);
    for (const sub of Object.values(SUB_REGS.get(r) ?? {})) {
      result.add(sub);
    }
  }
  return result;
}

function expandCoverings(regs: Set<string>): Set<string> {
  const subClosedRegs = expandSubRegs(regs);
  for (const [superReg, subRegs] of REG_COVERINGS) {
    if (subRegs.every((sub) => subClosedRegs.has(sub))) {
      subClosedRegs.add(superReg);
    }
  }
  return subClosedRegs;
}

function decomposeCoverings(regs: Set<string>): Set<string> {
  const result: Set<string> = new Set(regs);
  for (const [superReg, subRegs] of REG_COVERINGS) {
    if (result.has(superReg)) {
      result.delete(superReg);
      for (const sub of subRegs) {
        result.add(sub);
      }
    }
  }
  return result;
}

function expandAliases(reg: Set<string>): Set<string> {
  const subClosedRegs: Set<string> = new Set();
  for (const r of reg) {
    subClosedRegs.add(r);
    for (const sub of Object.values(SUB_REGS.get(r) ?? {})) {
      subClosedRegs.add(sub);
    }
  }
  const result: Set<string> = new Set();
  for (const r of subClosedRegs) {
    result.add(r);
    for (const sup of SUPER_REGS.get(r) ?? []) {
      result.add(sup);
    }
  }
  return result;
}

function instructionIO(inst: Instruction): [Set<string>, Set<string>] {
  const [dest, src] = instructionIOImpl(inst);
  return [new Set(dest), new Set(src)];
}
function instructionIOImpl(inst: Instruction): [string[], string[]] {
  function operandAsDest(op: RegisterOperand | MemoryOperand | ImmediateOperand): string[] {
    if (op.type === "RegisterOperand") {
      return [op.reg];
    } else {
      return [];
    }
  }
  function operandAsSrc(op: OperandExt): string[] {
    const set: Set<string> = new Set();
    search(op);
    function search(op: OperandExt) {
      switch (op.type) {
        case "RegisterOperand":
          set.add(op.reg);
          break;
        case "IndirectOperand":
          search(op.address);
          break;
        case "MemoryOperand":
          if (op.baseReg != null) {
            set.add(op.baseReg);
          }
          if (op.indexReg != null) {
            set.add(op.indexReg);
          }
          if (op.disp) {
            search(op.disp);
          }
          break;
        case "BinOpOperand":
          search(op.lhs);
          search(op.rhs);
          break;
        case "UnOpOperand":
          search(op.arg);
          break;
      }
    }
    return Array.from(set);
  }

  function dest(inst: GenericInstruction): string[] {
    if (inst.operands.length === 0) {
      return [];
    }
    const reg = asRegister(inst.operands[0]);
    if (reg) {
      return [reg];
    }
    return [];
  }
  function src(inst: GenericInstruction): string[] {
    const deps: Set<string> = new Set();
    for (const op of inst.operands) {
      search(op);
    }
    function search(op: Operand) {
      if (op.type === "RegisterOperand") {
        deps.add(op.reg);
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
  function isSelfOp(inst: GenericInstruction): boolean {
    if (inst.operands.length !== 2) {
      return false;
    }
    const [dest, src] = inst.operands;
    return dest.type === "RegisterOperand" && src.type === "RegisterOperand" && dest.reg === src.reg;
  }
  if (inst.type === "MovInstruction") {
    const { dest, src } = inst;
    return [operandAsSrc(src), operandAsDest(dest)];
  } else if (inst.type === "JmpInstruction") {
    // Should be handled by the caller
    return [[], []];
  } else if (inst.type === "JccInstruction") {
    switch (inst.condition) {
      // CF or its negation
      case "c":
      case "nc":
        return [["cf"], []];
      // CF && ZF or its negation
      case "a":
      case "na":
        return [["cf", "zf"], []];
      // SF ^ OF or its negation
      case "l":
      case "nl":
        return [["of", "sf"], []];
      // (SF ^ OF) || ZF or its negation
      case "le":
      case "nle":
        return [["of", "sf", "zf"], []];
      // ZF or its negation
      case "z":
      case "nz":
        return [["zf"], []];
      // OF or its negation
      case "o":
      case "no":
        return [["of"], []];
      // SF or its negation
      case "s":
      case "ns":
        return [["sf"], []];
      // PF or its negation
      case "p":
      case "np":
        return [["pf"], []];
      default:
        throw new Error("Unknown condition: " + inst.condition);
    }
  } else {
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
        console.log(`instructionIO: Unknown mnemonic, line ${inst.lineMetadata.line},`, inst.mnemonic);
        return [[], []];
    }
  }
}
function asRegister(operand: Operand): string | undefined {
  if (operand.type === "RegisterOperand") {
    operand.reg;
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
