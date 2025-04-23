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

const precedence = { '+': 1, '-': 1, '*': 2, '/': 2 };
const associative = { '+': true, '-': false, '*': true, '/': false };

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

function containsParens(expr) {
    return /[(){}\[\]]/.test(expr);
}

function renderExpression(tree, parentOp = null, isRight = false, level = 0) {
    if (!tree.type) return tree.value.toString();

    const left = renderExpression(tree.left, tree.op, false, level);
    const right = renderExpression(tree.right, tree.op, true, level);
    let expr = `${left} ${toSymbol(tree.op)} ${right}`;

    if (parentOp && needsParens(parentOp, tree, isRight)) {
        const inner = containsParens(expr) ?
            (expr.includes('[') ? [`{`, `}`] : [`[`, `]`]) : [`(`, `)`];
        expr = `${inner[0]}${expr}${inner[1]}`;
    }
    return expr;
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
