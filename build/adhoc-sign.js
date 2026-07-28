'use strict';

// electron-builder afterSign 훅.
// 서명 인증서가 없으므로 ad-hoc(-) 서명을 강제로 넣는다.
// 이렇게 하면 quarantine이 붙어도 macOS에서 우클릭→열기로 실행할 수 있다.
const { execSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
    console.log(`  • ad-hoc signed  ${appPath}`);
  } catch (e) {
    console.warn('  ⚠ ad-hoc 서명 실패:', e.message);
  }
};
