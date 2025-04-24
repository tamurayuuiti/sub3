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

function annotateDepthsBottomUp(tree) {
  if (!tree.type) {
    tree.depth = 0;
    return 0;
  }
  const leftDepth = annotateDepthsBottomUp(tree.left);
  const rightDepth = annotateDepthsBottomUp(tree.right);
  const depth = Math.max(leftDepth, rightDepth) + 1;
  tree.depth = depth;
  return depth;
}

const bracketStyles = [
  ['（', '）'],
  ['｛', '｝'],
  ['［', '］']
];

const precedence = { '+': 1, '-': 1, '*': 2, '/': 2 };
const associative = { '+': true, '*': true, '-': false, '/': false };

function needsParens(parentOp, childNode, isRight) {
  if (!childNode.type) return false;
  const childOp = childNode.op;
  const p1 = precedence[parentOp];
  const p2 = precedence[childOp];
  if (p2 > p1) return false;
  if (p2 < p1) return true;
  if (!associative[parentOp]) return isRight;
  return false;
}

function normalizeBracketLevel(depth, parentOp, childOp, usedLevels) {
  if (!usedLevels.has(0)) return 0;
  if (!usedLevels.has(1)) return 1;
  if (!usedLevels.has(2)) return 2;
  return Math.min(depth, 2);
}

function renderExpression(tree, parentOp = null, isRight = false, isRoot = true, usedLevels = new Set()) {
  if (!tree.type) return tree.value.toString();

  const left = renderExpression(tree.left, tree.op, false, false, usedLevels);
  const right = renderExpression(tree.right, tree.op, true, false, usedLevels);
  const expr = `${left} ${toSymbol(tree.op)} ${right}`;

  if (isRoot || !needsParens(parentOp, tree, isRight)) return expr;

  const bracketLevel = normalizeBracketLevel(tree.depth, parentOp, tree.op, usedLevels);
  usedLevels.add(bracketLevel);
  const [open, close] = bracketStyles[bracketLevel];
  return `${open}${expr}${close}`;
}

function toSymbol(op) {
  switch (op) {
    case '+': return '＋';
    case '-': return '－';
    case '*': return '×';
    case '/': return '÷';
    default: return op;
  }
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
            annotateDepthsBottomUp(tree);
            const usedLevels = new Set();
            const expr = renderExpression(tree, null, false, true, usedLevels);
            validExpressions.add(expr);
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
