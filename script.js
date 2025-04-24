window.onload = renderInputs;

function renderInputs() {
  const inputGroup = document.getElementById("numberInputs");
  inputGroup.innerHTML = '';
  const count = 4;
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
  if (nums.length === 1) return [{ value: nums[0] }];
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
    case '+': return '+';
    case '-': return '-';
    case '*': return '×';
    case '/': return '÷';
    default: return op;
  }
}

function needsParens(parentOp, childOp, isRight) {
  const p1 = precedence[parentOp];
  const p2 = precedence[childOp];
  if (p2 > p1) return false;
  if (p2 < p1) return true;
  if (!associative[parentOp]) return isRight;
  return false;
}

function renderExpression(tree, parentOp = null, isRight = false) {
  if (!tree.type) return tree.value.toString();
  const left = renderExpression(tree.left, tree.op, false);
  const right = renderExpression(tree.right, tree.op, true);
  const expr = `${left} ${toSymbol(tree.op)} ${right}`;
  if (!parentOp || !needsParens(parentOp, tree.op, isRight)) return expr;
  return adjustOuterBrackets(`(${expr})`);
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

function adjustOuterBrackets(expression) {
  const chars = expression.split('');
  const stack = [];
  const result = [...chars];

  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '(') {
      stack.push(i);
    } else if (chars[i] === ')') {
      const start = stack.pop();
      const inner = expression.slice(start + 1, i);
      if (inner.includes('(')) {
        result[start] = '{';
        result[i] = '}';
      }
    }
  }

  for (let i = 0; i < result.length; i++) {
    if (result[i] === '(') {
      let depth = 1;
      for (let j = i + 1; j < result.length; j++) {
        if (result[j] === '(') depth++;
        else if (result[j] === ')') depth--;
        if (depth === 0) {
          const inner = result.slice(i + 1, j).join('');
          if (inner.includes('{')) {
            result[i] = '[';
            result[j] = ']';
          }
          break;
        }
      }
    }
  }

  return result.join('');
}

function getCanonicalForm(tree) {
  if (!tree.type) return `${tree.value}`;
  const left = getCanonicalForm(tree.left);
  const right = getCanonicalForm(tree.right);
  if (tree.op === '+' || tree.op === '*') {
    const sorted = [left, right].sort();
    return `${tree.op}(${sorted[0]},${sorted[1]})`;
  }
  return `${tree.op}(${left},${right})`;
}

function findTargetExpressions(numbers, target, allowPermutations) {
  const operators = ['+', '-', '*', '/'];
  const numberSets = allowPermutations ? permute(numbers) : [numbers];
  const operatorCombinations = generateOperatorCombinations(operators, numbers.length - 1);
  const validExpressions = new Set();
  const canonicalForms = new Set();

  for (const nums of numberSets) {
    for (const ops of operatorCombinations) {
      const trees = generateAllExpressionTrees(nums, ops);
      for (const tree of trees) {
        try {
          const value = evaluateExpressionTree(tree);
          if (Math.abs(value - target) < 1e-6) {
            const canonical = getCanonicalForm(tree);
            if (canonicalForms.has(canonical)) continue;
            canonicalForms.add(canonical);
            const expr = renderExpression(tree);
            validExpressions.add(expr);
          }
        } catch (_) {}
      }
    }
  }
  return Array.from(validExpressions);
}

function calculateExpressions() {
  const allowPermutations = document.getElementById("allowPermute").value === 'true';
  const numbers = [];
  const count = 4;
  for (let i = 0; i < count; i++) {
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
  if (results.length > 0) {
    resultDiv.innerHTML = `<p>見つかった式の数: ${results.length}</p>` +
      "<ul class='result-list'>" +
      results.map(expr => `<li>${expr}</li>`).join('') +
      "</ul>";
  } else {
    resultDiv.innerHTML = "<p style='color:red;'>指定の値を作成できる式は見つかりませんでした。</p>";
  }
}
