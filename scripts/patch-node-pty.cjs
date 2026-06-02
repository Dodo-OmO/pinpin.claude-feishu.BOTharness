/**
 * postinstall patch —— 修 node-pty 在非 ASCII（中文）路径 + VS2022（无 Spectre 库）下重编失败。
 *
 * 根因 1：winpty.gyp 用 `cmd /c "cd shared && X.bat"` 调 GetCommitHash.bat / UpdateGenVersion.bat。
 * 在中文路径下 cmd && 链式调用挂（`&&` 依赖上一条命令 ERRORLEVEL 为 0，中文路径下 cd 后
 * GetCommitHash.bat 找不到导致 ERRORLEVEL 非 0，整条链不执行）。
 * 改为 `cd shared & call .\X.bat`：单 `&` 不检查 ERRORLEVEL，`call .\X.bat` 让 cmd.exe
 * 在当前目录（shared/）找 bat 文件，保持 cwd 在 shared/（UpdateGenVersion.bat 需要在
 * shared/ 执行才能正确创建 ..\gen\ → src/gen/ 目录）。
 *
 * 根因 2：winpty.gyp 的 winpty-agent / winpty target 在 msvs_configuration_attributes 里写了
 * `'SpectreMitigation': 'Spectre'`，gyp configure 生成 vcxproj 时写入
 * `<SpectreMitigation>Spectre</SpectreMitigation>`，VS2022 MSBuild（v170）遇到该字段强制
 * 要求安装 Spectre-mitigated 库组件（MSB8040），没装就报错。
 * 改为 `'SpectreMitigation': 'false'` 让 gyp 生成 `<SpectreMitigation>false</SpectreMitigation>`，
 * MSBuild 跳过 Spectre 检查，不影响功能（Spectre 缓解仅影响安全审计场景）。
 *
 * 根因 3：node-gyp 内置的 easy_xml.py 在中文 Windows（GBK locale）下用系统编码打开
 * 已有的 UTF-8 vcxproj.filters 文件（open(path) 不传 encoding），导致
 * UnicodeDecodeError: 'gbk' codec can't decode byte 0xab。
 * 修 easy_xml.py：把 `with open(path) as file:` 改为 `with open(path, encoding='utf-8') as file:`，
 * 让读操作强制用 UTF-8，不受系统 locale 影响。
 *
 * 每次 npm install 后自动跑（由 package.json 的 postinstall 钩调起）。
 * 非 Windows 或 node-pty 未装时静默跳过——不影响 Linux/Mac 用户。
 */

const fs = require('fs');
const path = require('path');

// ── Patch A: winpty.gyp ──────────────────────────────────────────────────────

const gypTarget = path.join(
  __dirname,
  '..',
  'node_modules',
  'node-pty',
  'deps',
  'winpty',
  'src',
  'winpty.gyp',
);

if (!fs.existsSync(gypTarget)) {
  console.log('[patch-node-pty] winpty.gyp 不存在，跳过（非 Windows 或 node-pty 未装）');
  process.exit(0);
}

// 读文件；去掉可能存在的 UTF-8 BOM（U+FEFF），避免 Python eval 报 SyntaxError invalid non-printable U+FEFF
const rawGypContent = fs.readFileSync(gypTarget, 'utf8');
const hasBom = rawGypContent.charCodeAt(0) === 0xFEFF;
const original = hasBom ? rawGypContent.slice(1) : rawGypContent;

// --- Patch A1: 中文路径 cmd && 链式调用修复 ---
// 原写法 `cmd /c "cd shared && X.bat"` 在中文路径下挂：`&&` 要求上一条命令退出码 0，
// 但中文路径会导致 cmd.exe 解析 cwd 时出错，GetCommitHash.bat 找不到（ERRORLEVEL 非 0），
// 整条链不执行。
// 改用 `cd shared & call .\X.bat`：
//   - 单 `&` 无论前命令退出码都执行后命令（跳过 && 依赖 ERRORLEVEL）
//   - `call .\X.bat` 加 `.\` 前缀让 cmd.exe 在当前目录找 bat（不走 PATH）
// 注：gyp 内写 literal 单引号包裹的字符串，文件里即是 `"cd shared & call .\X.bat"`
const gypReplacements = [
  ['cd shared && GetCommitHash.bat', 'cd shared & call .\\\\GetCommitHash.bat'],
  ['cd shared && UpdateGenVersion.bat', 'cd shared & call .\\\\UpdateGenVersion.bat'],
  // 修上一轮残留的 shared\\ 版本（直接路径方式，导致 bat 在 src/ 而非 shared/ 执行，gen/ 目录偏移）
  ['shared\\\\GetCommitHash.bat', 'cd shared & call .\\\\GetCommitHash.bat'],
  ['shared\\\\UpdateGenVersion.bat', 'cd shared & call .\\\\UpdateGenVersion.bat'],
  // 其它残留格式
  ['shared/GetCommitHash.bat', 'cd shared & call .\\\\GetCommitHash.bat'],
  ['shared/UpdateGenVersion.bat', 'cd shared & call .\\\\UpdateGenVersion.bat'],
  // --- Patch A2: VS2022 无 Spectre-mitigated 库时关闭 MSB8040 检查 ---
  // winpty.gyp 的 winpty-agent / winpty target 在 msvs_configuration_attributes 里写了
  // 'SpectreMitigation': 'Spectre'，gyp 生成 vcxproj 时变成 <SpectreMitigation>Spectre</SpectreMitigation>，
  // VS2022 MSBuild v170 强制要求 Spectre 组件，未装就 MSB8040 报错阻断 build。
  // 改为 'false' → <SpectreMitigation>false</SpectreMitigation>，MSBuild 不再要求 Spectre 组件。
  ["'SpectreMitigation': 'Spectre'", "'SpectreMitigation': 'false'"],
];

let patched = original;
const applied = [];
for (const [from, to] of gypReplacements) {
  if (patched.includes(from)) {
    patched = patched.split(from).join(to);
    applied.push(from);
  }
}

// 无论内容是否变化，只要文件有 BOM 或有需要替换的内容，就写回（确保 BOM 被移除）
if (applied.length > 0 || hasBom) {
  fs.writeFileSync(gypTarget, patched);  // 不带 BOM 写回
  if (hasBom) console.log('[patch-node-pty] winpty.gyp: 已移除 UTF-8 BOM（Python eval 不兼容）');
  if (applied.length > 0) console.log(`[patch-node-pty] winpty.gyp: 已 patch ${applied.length} 处 (中文路径cmd&&兼容 + VS2022无Spectre组件兼容)`);
} else {
  console.log('[patch-node-pty] winpty.gyp 已 patch 过 / 上游已修，跳过');
}

// 1.5 fail-loud：中文路径关键 patch（cmd 链 `cd shared & call`）必须在位。
// 缺失 = node-pty 上游 gyp 格式已变、patch 失效——静默放行会让 electron-rebuild 在中文路径下
// 炸且报错指向不明（伪成功陷阱）。在此显式 exit(1) 求救，提示更新本脚本的替换规则。
// 该断言对"已 patch"（含目标串）与"新装"（替换后含目标串）两态都正确，不会误报。
if (!patched.includes('cd shared & call')) {
  console.error(
    '[patch-node-pty] ❌ winpty.gyp 缺少中文路径关键 patch（"cd shared & call"）——' +
    'node-pty 上游 gyp 格式可能已变、patch 失效，中文路径下重编将失败。' +
    '请更新 scripts/patch-node-pty.cjs 的替换规则后重试。',
  );
  process.exit(1);
}

// ── Patch A': binding.gyp SpectreMitigation ──────────────────────────────────
//
// binding.gyp 的 target_defaults.conditions[OS=="win"].msvs_configuration_attributes 里
// 同样写了 'SpectreMitigation': 'Spectre'，影响 conpty / conpty_console_list target，
// 导致 conpty.vcxproj / conpty_console_list.vcxproj 也报 MSB8040。
// 改法与 winpty.gyp 相同：'Spectre' → 'false'。

const bindingGypTarget = path.join(
  __dirname,
  '..',
  'node_modules',
  'node-pty',
  'binding.gyp',
);

if (fs.existsSync(bindingGypTarget)) {
  const rawBinding = fs.readFileSync(bindingGypTarget, 'utf8');
  const hasBomBinding = rawBinding.charCodeAt(0) === 0xFEFF;
  const origBinding = hasBomBinding ? rawBinding.slice(1) : rawBinding;
  const patchedBinding = origBinding.split("'SpectreMitigation': 'Spectre'").join("'SpectreMitigation': 'false'");
  const bindingChanged = patchedBinding !== origBinding;
  if (bindingChanged || hasBomBinding) {
    fs.writeFileSync(bindingGypTarget, patchedBinding);
    if (hasBomBinding) console.log('[patch-node-pty] binding.gyp: 已移除 UTF-8 BOM');
    if (bindingChanged) console.log('[patch-node-pty] binding.gyp: 已 patch SpectreMitigation (VS2022无Spectre组件兼容)');
  } else {
    console.log('[patch-node-pty] binding.gyp 已 patch 过 / 上游已修，跳过');
  }
}

// ── Patch B: node-gyp easy_xml.py GBK encoding bug ──────────────────────────
//
// node-gyp 内置的 easy_xml.py WriteXmlIfChanged 函数用 open(path) 读已有 xml 文件
// 做 diff，但没有指定 encoding，在中文 Windows（GBK locale）下会用 GBK 解码
// UTF-8 写入的 vcxproj.filters 文件，触发 UnicodeDecodeError。
// 修复：把 `with open(path) as file:` 改为 `with open(path, encoding='utf-8') as file:`。

const easyXmlTarget = path.join(
  __dirname,
  '..',
  'node_modules',
  'node-gyp',
  'gyp',
  'pylib',
  'gyp',
  'easy_xml.py',
);

if (fs.existsSync(easyXmlTarget)) {
  const xmlOrig = fs.readFileSync(easyXmlTarget, 'utf8');
  const xmlFrom = "        with open(path) as file:";
  const xmlTo   = "        with open(path, encoding='utf-8') as file:";
  if (xmlOrig.includes(xmlFrom)) {
    fs.writeFileSync(easyXmlTarget, xmlOrig.split(xmlFrom).join(xmlTo));
    console.log('[patch-node-pty] easy_xml.py: 已 patch (GBK locale UTF-8 读取兼容)');
  } else {
    console.log('[patch-node-pty] easy_xml.py 已 patch 过 / 上游已修，跳过');
  }
}
