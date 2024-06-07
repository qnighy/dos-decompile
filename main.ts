async function main() {
  const asmText = trimSub(await Deno.readTextFile("MS-DOS/v1.25/source/ASM.ASM"));
  const tokens = tokenize(asmText);
  const lines = parseLines(tokens);
  let cText = "int main() {\n";
  for (const line of lines) {
    for (const leadingComment of line.leadingComments) {
      cText += `  // ${leadingComment}\n`;
    }
    if (line.type === "Label") {
      cText += `${line.name}:`;
    } else if (line.type === "Instruction") {
      cText += `  asm("${escapeC(stringifyInstruction(line))}");`;
    }
    if (line.trailingComments.length > 0) {
      cText += " //";
      for (const trailingComment of line.trailingComments) {
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
        mnemonic: mnemonicToken.text,
        operands,
        line: mnemonicToken.line,
        leadingComments: mnemonicToken.leadingComments,
        trailingComments: mnemonicToken.trailingComments,
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
