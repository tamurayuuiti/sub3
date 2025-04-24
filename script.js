window.onload = renderInputs;

function renderInputs() {
  const count = parseInt(document.getElementById("digitCount").value);
  const inputGroup = document.getElementById("numberInputs");
  inputGroup.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const input = document.createElement("input");
    input.type = "number";
    input.min = 1;
    input.max = 9;
    input.id = `num${i + 1}`;
    inputGroup.appendChild(input);
  }
}

function permute(arr) {
  if (arr.length === 1) return [arr];
  const perms = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = permute(arr.slice(0, i).concat(arr.slice(i + 1)));
    for (let r of rest) {
      perms.push([arr[i]].concat(r));
    }
  }
  return perms;
}

function generateOperatorCombinations(operators, count) {
  if (count === 0) return [[]];
  const prev = generateOperatorCombinations(operators, count - 1);
  const result = [];
  for (let p of prev) {
    for (let op of operators) {
      result.push([...p, op]);
    }
  }
  return result;
}

function generateAllExpressionTrees(nums, ops) {
  if (nums.length === 1 && nums[0] !== undefined) {
    return [{ value: nums[0] }];
  }
  const trees = [];
  for (let i = 1; i < nums.length; i++) {
    const leftNums = nums.slice(0, i);
    const rightNums = nums.slice(i);
    const leftOps = ops.slice(0, i - 1);
    const rightOps = ops.slice(i);
    const leftTrees = generateAllExpressionTrees(leftNums, leftOps);
    const rightTrees = generateAllExpressionTrees(rightNums, rightOps);
    const op = ops[i - 1];
    for (const left of leftTrees) {
      for (const right of rightTrees) {
        trees.push({ type: 'op', op, left, right });
      }
    }
  }
  return trees;
}

const precedence = { '+': 1, '-': 1, '*': 2, '/': 2 };
const associative = { '+': true, '*': true, '-': false, '/': false };

function toSymbol(op) {
  switch (op) {
    case '+': return '＋';
    case '-': return '－';
    case '*': return '×';
    case '/': return '÷';
    default: return op;
  }
}

function renderFlatExpression(tree) {
  if (!tree.type) return tree.value.toString();
  const left = renderFlatExpression(tree.left);
  const right = renderFlatExpression(tree.right);
  return `${left} ${tree.op} ${right}`;
}

function insertBrackets(expr) {
  const tokens = expr.split(/\s+/);
  const ops = ['+', '-', '*', '/'];
  const stack = [];

  function getPrecedence(op) {
    return precedence[op] ?? 0;
  }

  let output = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!ops.includes(tok)) {
      output.push(tok);
    } else {
      const right = output.pop();
      const left = output.pop();
      const p = getPrecedence(tok);
      let l = left;
      let r = right;

      // Wrap if lower precedence detected
      if (/[+\-*/]/.test(l) && getPrecedence(l.split(' ')[1]) < p) l = `（${l}）`;
      if (/[+\-*/]/.test(r) && getPrecedence(r.split(' ')[1]) < p) r = `（${r}）`;

      output.push(`${l} ${tok} ${r}`);
    }
  }
  return output[0];
}

function toStyledBrackets(expr) {
  let depth = 0;
  const stack = [];
  let out = '';
  for (let ch of expr) {
    if (ch === '（') {
      stack.push(depth);
      out += ['（', '｛', '［'][depth % 3];
      depth++;
    } else if (ch === '）') {
      depth--;
      out += ['）', '｝', '］'][stack.pop() % 3];
    } else {
      out += ch;
    }
  }
  return out;
}

function evaluateExpressionTree(tree) {
  if (!tree.type) return Number(tree.value);
  const left = evaluateExpressionTree(tree.left);
  const right = evaluateExpressionTree(tree.right);
  switch (tree.op) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/': return right !== 0 ? left / right : NaN;
  }
}

function findTargetExpressions(numbers, target, allowPermutations) {
  const operators = ['+', '-', '*', '/'];
  const numberSets = allowPermutations ? permute(numbers) : [numbers];
  const operatorCombinations = generateOperatorCombinations(operators, numbers.length - 1);
  const validExpressions = new Set();

  for (const nums of numberSets) {
    for (const ops of operatorCombinations) {
      const trees = generateAllExpressionTrees(nums, ops);
      for (const tree of trees) {
        try {
          const value = evaluateExpressionTree(tree);
          if (Math.abs(value - target) < 1e-6) {
            const flat = renderFlatExpression(tree);
            const bracketed = insertBrackets(flat);
            const styled = toStyledBrackets(bracketed.replace(/[+\-*/]/g, toSymbol));
            validExpressions.add(styled);
          }
        } catch (_) {}
      }
    }
  }
  return Array.from(validExpressions);
}

function calculateExpressions() {
  const digitCount = parseInt(document.getElementById("digitCount").value);
  const allowPermutations = document.getElementById("allowPermute").value === 'true';
  const numbers = [];
  for (let i = 0; i < digitCount; i++) {
    const value = parseInt(document.getElementById(`num${i + 1}`).value);
    if (isNaN(value) || value < 1 || value > 9) {
      document.getElementById("result").innerHTML = "<p style='color:red;'>1〜9の範囲で入力してください。</p>";
      return;
    }
    numbers.push(value);
  }
  const target = parseInt(document.getElementById("target").value);
  if (isNaN(target)) {
    document.getElementById("result").innerHTML = "<p style='color:red;'>目標の値を入力してください。</p>";
    return;
  }
  const results = findTargetExpressions(numbers, target, allowPermutations);
  const resultDiv = document.getElementById("result");
  resultDiv.innerHTML = results.length
    ? "<p>見つかった式:</p><ul class='result-list'>" + results.map(expr => `<li>${expr}</li>`).join('') + "</ul>"
    : "<p style='color:red;'>指定したターゲット値を作成できる式は見つかりませんでした。</p>";
}
