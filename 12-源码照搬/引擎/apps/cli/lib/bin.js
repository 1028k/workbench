// 兼容垫片（shim）
//
// 工作台外壳按「DSH 源码仓库」的布局找引擎入口：
//     <引擎>\apps\cli\lib\bin.js
// 这台机器装的是 npm 上的发布包（@deepseek-ai/dsh），入口在
//     <引擎>\node_modules\@deepseek-ai\dsh\lib\bin.js
// 两者是同一个 CLI。发布包的 bin.js 只在「自己是入口」时才执行
// （`if (import.meta.main) await runCli()`），被别的文件 import 时不会跑，
// 所以这里显式调用它导出的 runCli()。
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', '..', '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

const cli = await import(pathToFileURL(target).href);
await cli.runCli();
