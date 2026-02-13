import fs from 'fs';
import path from 'path';

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
const deps = {...pkg.dependencies, ...pkg.devDependencies};
const licenses = {};

for (const name of Object.keys(deps)) {
  try {
    const pkgPath = path.join('node_modules', name, 'package.json');
    const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    licenses[name] = pkgJson.license || 'Unknown';
  } catch (e) {
    licenses[name] = 'Not found';
  }
}

const grouped = {};
for (const [name, license] of Object.entries(licenses)) {
  if (!grouped[license]) grouped[license] = [];
  grouped[license].push(name);
}

console.log('# NPM 依赖许可证分析\n');
for (const [license, pkgs] of Object.entries(grouped).sort()) {
  console.log(`\n## ${license} (${pkgs.length}个包)`);
  console.log(pkgs.join(', '));
}
