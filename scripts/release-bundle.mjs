#!/usr/bin/env node
import { cp, chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supportedTargets = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64']);

export function createBundlePlan({ version, platform, arch }) {
  const target = `${platform}-${arch}`;
  if (!supportedTargets.has(target)) {
    throw new Error(`Unsupported release target: ${target}`);
  }
  if (!version) throw new Error('A release version is required');

  return {
    archiveName: `relay-v${version}-${target}.tar.gz`,
    bundleName: `relay-v${version}-${target}`,
    requiredPaths: ['relay', 'runtime/bin/node', 'app/dist/cli.js', 'app/node_modules', 'RELEASE.json'],
  };
}

async function readPackageVersion() {
  const source = await readFile(join(projectRoot, 'package.json'), 'utf8');
  return JSON.parse(source).version;
}

async function copyRuntime(nodePath, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(nodePath, destination, { force: true });
  await chmod(destination, 0o755);
}

async function buildBundle({ version, platform, arch, outputDir, nodePath }) {
  const plan = createBundlePlan({ version, platform, arch });
  const bundleRoot = join(outputDir, plan.bundleName);
  const appRoot = join(bundleRoot, 'app');
  await rm(bundleRoot, { recursive: true, force: true });
  await mkdir(appRoot, { recursive: true });

  await cp(join(projectRoot, 'dist'), join(appRoot, 'dist'), { recursive: true });
  await cp(join(projectRoot, 'package.json'), join(appRoot, 'package.json'));
  await cp(join(projectRoot, 'package-lock.json'), join(appRoot, 'package-lock.json'));
  await execFileAsync('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: appRoot });
  await copyRuntime(nodePath, join(bundleRoot, 'runtime', 'bin', 'node'));
  await writeFile(join(bundleRoot, 'relay'), '#!/usr/bin/env sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$ROOT/runtime/bin/node" "$ROOT/app/dist/cli.js" "$@"\n');
  await chmod(join(bundleRoot, 'relay'), 0o755);
  await writeFile(join(bundleRoot, 'RELEASE.json'), `${JSON.stringify({ version, platform, arch }, null, 2)}\n`);
  await execFileAsync('tar', ['-czf', join(outputDir, plan.archiveName), '-C', outputDir, plan.bundleName]);
  return join(outputDir, plan.archiveName);
}

async function main() {
  const [platform = process.platform, arch = process.arch] = process.argv.slice(2);
  const version = await readPackageVersion();
  const outputDir = resolve(process.env['RELAY_RELEASE_DIR'] ?? join(projectRoot, 'release'));
  const nodePath = resolve(process.env['RELAY_NODE_RUNTIME'] ?? process.execPath);
  await stat(nodePath);
  await mkdir(outputDir, { recursive: true });
  const archive = await buildBundle({ version, platform, arch, outputDir, nodePath });
  process.stdout.write(`${basename(archive)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`release bundle failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
