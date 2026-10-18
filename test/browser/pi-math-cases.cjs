// Synthetic formulas only: these fixtures must never copy a private conversation.
const delimiters = [
    ['dollar', tex => `$${tex}$`],
    ['parenthesis', tex => `\\(${tex}\\)`],
    ['double dollar', tex => `$$\n${tex}\n$$`],
    ['bracket', tex => `\\[\n${tex}\n\\]`]
];
const valid = [], add = (name, source, annotations, extra = {}) => valid.push({ name, source, annotations, headings: 0, ...extra });
const common = [
    String.raw`x_i^2+\frac{a_1}{b^2}`, String.raw`\sqrt[n]{x}+\dfrac{1}{1+x}`,
    String.raw`\sum_{k=1}^{\infty}\frac{1}{k^2}=\frac{\pi^2}{6}`,
    String.raw`\int_0^1 x^2\,\mathrm dx=\frac13`, String.raw`\lim_{x\to0}\frac{\sin x}{x}=1`,
    String.raw`\hat x+\bar x+\vec v+\overrightarrow{AB}+\dot x+\ddot x`,
    String.raw`\underbrace{a+\cdots+a}_{n\text{ 项}}=na,\quad\binom nk`,
    String.raw`\operatorname{rank}(A),\det A,\gcd(a,b),a\equiv b\pmod m`,
    String.raw`\mathbb R,\mathcal F,\mathbf x,\boldsymbol\alpha,\mathrm d,\mathsf A`,
    String.raw`A\xrightarrow{f}B\overset{g}{\longrightarrow}C\iff A\implies B`,
    String.raw`\boxed{\left|\frac{x}{y}\right|\le\lVert v\rVert}`,
    String.raw`\text{当 }x>0\text{ 时，}f(x)=x`, 'α+β≤∞，x∈ℝ',
    String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`, String.raw`\begin{bmatrix}1&0\\0&1\end{bmatrix}`,
    String.raw`\begin{vmatrix}a&b\\c&d\end{vmatrix}`, String.raw`\begin{smallmatrix}a&b\\c&d\end{smallmatrix}`,
    String.raw`\begin{cases}x^2&x\ge0\\-x&x<0\end{cases}`
];
for (const [name, wrap] of delimiters) {
    for (const [index, tex] of common.entries()) add(`${name}: common ${index}`, wrap(tex), [tex]);
    for (const [mark, field] of [['*', 'em'], ['**', 'strong'], ['_', 'em'], ['~~', 'del']]) {
        const tex = 'a*b+c_d~e';
        add(`${name}: ${field} around math`, `${mark}求 ${wrap(tex)} 的值${mark}`, [tex], { [field]: 1 });
    }
}
const multiline = 'a\n=\nb';
for (const [name, wrap] of delimiters.slice(2)) {
    const math = wrap(multiline);
    add(`${name}: prose without blank line`, `说明\n${math}`, [multiline]);
    add(`${name}: blockquote`, `> 说明\n> ${math.replace(/\n/g, '\n> ')}`, [multiline], { blockquotes: 1 });
    add(`${name}: list`, `- 说明\n  ${math.replace(/\n/g, '\n  ')}`, [multiline], { listItems: 1 });
    add(`${name}: nested list`, `1. 外层\n   - 内层\n     ${math.replace(/\n/g, '\n     ')}`, [multiline], { listItems: 2 });
    add(`${name}: loose list`, `- 说明\n\n  ${math.replace(/\n/g, '\n  ')}`, [multiline], { listItems: 1 });
    add(`${name}: punctuation after closing delimiter`, `${math}。`, [multiline]);
    add(`${name}: text after closing delimiter`, `${math} result`, [multiline]);
    const matrix = String.raw`\begin{pmatrix}1\\2\end{pmatrix}` + '\n=\n' + String.raw`\begin{pmatrix}3\\4\end{pmatrix}`;
    add(`${name}: matrix equality`, '说明\n' + wrap(matrix), [matrix]);
    const aligned = String.raw`\begin{aligned}a&=b+c\\d&=e\end{aligned}`;
    add(`${name}: aligned`, wrap(aligned), [aligned]);
    const alignedat = String.raw`\begin{alignedat}{2}a&=b&\quad c&=d\\e&=f&\quad g&=h\end{alignedat}`;
    add(`${name}: alignedat`, wrap(alignedat), [alignedat]);
    const array = String.raw`\left[\begin{array}{c|c}a&b\\c&d\end{array}\right]`;
    add(`${name}: augmented array`, wrap(array), [array]);
    add(`${name}: equation tag`, wrap(String.raw`a=b\tag{1}`), [String.raw`a=b\tag{1}`]);
    const comment = String.raw`a=1 % \] $$ are in a comment` + '\n+2';
    add(`${name}: comment with delimiters`, wrap(comment), [comment]);
}
add('multiline inline bracket', '说明 \\[a\n=\nb\\]', [multiline]);
add('multiline inline parenthesis', '说明 \\(a\n=\nb\\)', [multiline]);
for (const [open, close] of [['\\(', '\\)'], ['\\[', '\\]'], ['$$', '$$']]) {
    for (const [kind, prefix, indent, extra] of [['list', '- ', '  ', { listItems: 1 }], ['quote', '> ', '> ', { blockquotes: 1 }]]) {
        add(`${kind}: multiline math after inline prose ${open}`, `${prefix}说明 ${open}a\n${indent}=\n${indent}b${close}`, [multiline], extra);
    }
}
add('subtraction on its own line', '说明\n\\[a\n-\nb\\]', ['a\n-\nb']);
add('adjacent inline dollar formulas', String.raw`$x$$y$ \(a\)\(b\)`, ['x', 'y', 'a', 'b']);
add('verbatim dollar delimiter', String.raw`$\verb|a$b|+x$`, [String.raw`\verb|a$b|+x`]);
add('verbatim bracket delimiter', String.raw`\[\verb|a\]b|+x\]`, [String.raw`\verb|a\]b|+x`]);
add('escaped percent', String.raw`\(100\%+x\)`, [String.raw`100\%+x`]);
add('escaped dollar inside text', String.raw`\[\text{\$5}+x\]`, [String.raw`\text{\$5}+x`]);
add('real heading containing math', String.raw`Title \(x_1+1\)` + '\n====', ['x_1+1'], { headings: 1 });
add('real ATX heading containing math', String.raw`# \(x_1+1\)`, ['x_1+1'], { headings: 1 });
add('link containing math', String.raw`[求 \(x\)](https://example.invalid/)`, ['x'], { links: 1 });
add('currency followed by math', String.raw`价格 $5，公式 $x+1$`, ['x+1']);
add('local macro', String.raw`\[\newcommand{\RR}{\mathbb{R}}\RR\]`, [String.raw`\newcommand{\RR}{\mathbb{R}}\RR`]);
add('math fence', '```math\na=b\n```', ['a=b']);
add('latex fence', '~~~latex\na=b\n~~~', ['a=b']);
for (const [name, wrap] of delimiters) {
    for (const tex of [String.raw`\left|x\right|`, String.raw`\|x\|`, String.raw`\left\|x\right\|`, String.raw`\begin{array}{c|c}a&b\\c&d\end{array}`, String.raw`\verb|a$b|`]) {
        const math = wrap(tex).replace(/\n/g, '');
        add(`${name}: table pipes ${tex}`, `| ${math} | 说明 |\n|---|---|\n| ${math} | KEEP |`, [tex, tex], { tableColumns: [2], keep: true });
    }
}
const ordinary = [
    '# Heading\n\nPlain text.', 'Title\n=====\n\nSubtitle\n-----', '**bold** and *italic* and ~~delete~~',
    '价格 $5 和 $10；US$5.00；$5 to $10', String.raw`\$5 和 \$10`, String.raw`\\(x\\) \\[x\\]`,
    '`\\[x\\]`\n\n```tex\n\\[a\n=\nb\\]\n```', '    \\[a=b\\]',
    '说明 `\\[`\na\n=\nb',
    '<textarea>\\(x\\)</textarea>', '<pre>\\[a\n=\nb\\]</pre>',
    '**保留 `a*b` 和 `$literal text$` 的原样代码**',
    '- one\n- two\n\n> quote', '| a | b |\n|---|---|\n| a\\|b | KEEP |',
    '```math\na=b', '~~~latex\na=b', '<span title="\\[x\\]">safe</span>'
];
const fallback = [
    String.raw`\(a_b`, '\\[\na\n=\nb', '$$\na\n=\nb',
    String.raw`\(\badcommand{x}\)`, String.raw`\[\frac{1}{\]`,
    String.raw`\(当x>0时\)`, String.raw`\[\ce{H2O}\]`, String.raw`\[\require{physics}\dv{x}{t}\]`,
    String.raw`\(a=b\tag{1}\)`, String.raw`\[\RR\]`, String.raw`\[\label{one}x\]`, String.raw`\[\eqref{one}\]`
];
const rawCode = [
    ['<code>\\(x\\)</code><kbd>$x$</kbd><samp>\\[y\\]</samp>', String.raw`\(x\)$x$\[y\]`],
    ['<code>\\(x\\)', String.raw`\(x\)`],
    ['<code><kbd>\\[x\\]</kbd>\\(y\\)</code>', String.raw`\[x\]\(y\)`]
];
module.exports = { valid, ordinary, fallback, rawCode };
