import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('酒馆实际加载的发布文件', () => {
    it('入口语法有效，无 Git 冲突标记，版本与清单一致', () => {
        const checker = fileURLToPath(new URL('../../scripts/check-release.mjs', import.meta.url));
        expect(() => execFileSync(process.execPath, [checker], { encoding: 'utf8' })).not.toThrow();
    });
});
