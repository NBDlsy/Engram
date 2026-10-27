import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));

if (manifest.version !== pkg.version) {
    throw new Error('发布版本不一致：manifest.json 与 package.json');
}

// 酒馆直接加载这些文件，构建成功不代表已提交的 dist 一定可加载。
for (const file of [manifest.js, manifest.css, manifest.html, 'CHANGELOG.md']) {
    const content = read(file);
    if (/^(?:<{7}(?:\s|$)|={7}\s*$|>{7}(?:\s|$))/m.test(content)) {
        throw new Error(`发布文件含未解决的 Git 冲突标记：${file}`);
    }
}

const syntax = spawnSync(process.execPath, ['--check', resolve(root, manifest.js)], { encoding: 'utf8' });
if (syntax.error) {throw syntax.error;}
if (syntax.status !== 0) {
    throw new Error(`扩展入口语法检查失败：${syntax.stderr}`);
}
const bundle = read(manifest.js);
if (!['"', "'", '`'].some(quote => bundle.includes(`${quote}${manifest.version}${quote}`))) {
    throw new Error('扩展入口未包含当前版本，请重新运行 pnpm build');
}
console.log(`Engram ${manifest.version} 发布文件检查通过`);
