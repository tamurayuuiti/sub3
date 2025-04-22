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

function wrapByLevel(expr, level, isOuter = false) {
    const needsWrap = /[+\-*/]/.test(expr);
    if (!needsWrap) return expr;
    if (level === 1) return `（${expr}）`;
    if (level === 2 && !isOuter) return `｛${expr}｝`;
    if (level === 3 && !isOuter) return `［${expr}］`;
    return expr;
}

function generateExpressions(nums, ops) {
    const expressions = [];
    const n = nums.length;

    if (n === 3) {
        expressions.push(`${wrapByLevel(`${wrapByLevel(`${nums[0]} ${ops[0]} ${nums[1]}`, 1)} ${ops[1]} ${nums[2]}`, 2, true)}`);
        expressions.push(`${wrapByLevel(`${nums[0]} ${ops[0]} ${wrapByLevel(`${nums[1]} ${ops[1]} ${nums[2]}`, 1)}`, 2, true)}`);
    } else if (n === 4) {
        expressions.push(`${wrapByLevel(`${wrapByLevel(`${nums[0]} ${ops[0]} ${nums[1]}`, 1)} ${ops[1]} ${wrapByLevel(`${nums[2]} ${ops[2]} ${nums[3]}`, 1)}`, 2, true)}`);
        expressions.push(`${wrapByLevel(`${wrapByLevel(`${wrapByLevel(`${nums[0]} ${ops[0]} ${nums[1]}`, 1)} ${ops[1]} ${nums[2]}`, 2)} ${ops[2]} ${nums[3]}`, 3, true)}`);
        expressions.push(`${wrapByLevel(`${wrapByLevel(`${nums[0]} ${ops[0]} ${wrapByLevel(`${nums[1]} ${ops[1]} ${nums[2]}`, 1)}`, 2)} ${ops[2]} ${nums[3]}`, 3, true)}`);
        expressions.push(`${wrapByLevel(`${nums[0]} ${ops[0]} ${wrapByLevel(`${wrapByLevel(`${nums[1]} ${ops[1]} ${nums[2]}`, 1)} ${ops[2]} ${nums[3]}`, 2)}`, 3, true)}`);
    } else if (n === 5) {
        expressions.push(`${wrapByLevel(`${wrapByLevel(`${wrapByLevel(`${wrapByLevel(`${nums[0]} ${ops[0]} ${nums[1]}`, 1)} ${ops[1]} ${nums[2]}`, 2)} ${ops[2]} ${nums[3]}`, 3)} ${ops[3]} ${nums[4]}`, 3, true)}`);
        expressions.push(`${wrapByLevel(`${nums[0]} ${ops[0]} ${wrapByLevel(`${nums[1]} ${ops[1]} ${wrapByLevel(`${nums[2]} ${ops[2]} ${wrapByLevel(`${nums[3]} ${ops[3]} ${nums[4]}`, 1)}`, 2)}`, 3)}`, 3, true)}`);
        expressions.push(`${wrapByLevel(`${wrapByLevel(`${nums[0]} ${ops[0]} ${nums[1]}`, 1)} ${ops[1]} ${wrapByLevel(`${nums[2]} ${ops[2]} ${wrapByLevel(`${nums[3]} ${ops[3]} ${nums[4]}`, 1)}`, 2)}`, 3, true)}`);
    }
    return expressions;
}

function findTargetExpressions(numbers, target, allowPermutations) {
    const operators = ['+', '-', '*', '/'];
    const numberSets = allowPermutations ? permute(numbers) : [numbers];
    const operatorCombinations = generateOperatorCombinations(operators, numbers.length - 1);
    const validExpressions = new Set();

    for (const nums of numberSets) {
        for (const ops of operatorCombinations) {
            const expressions = generateExpressions(nums, ops);
            for (const expr of expressions) {
                try {
                    const evalExpr = expr
                        .replace(/［/g, '(')
                        .replace(/｛/g, '(')
                        .replace(/（/g, '(')
                        .replace(/］/g, ')')
                        .replace(/｝/g, ')')
                        .replace(/）/g, ')');
                    if (Math.abs(eval(evalExpr) - target) < 1e-6) {
                        const formatted = expr.replace(/\*/g, '×').replace(/\//g, '÷');
                        validExpressions.add(formatted);
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
