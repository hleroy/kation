// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Keeps `src/proton/` equal to the Proton Drive CLI's sources in the SDK
 * submodule, minus the files listed in NOT_COPIED, plus `kation.patch`.
 * See `src/proton/README.md` for the upgrade procedure.
 *
 * Usage: bun ./scripts/protonCopy.ts check | update | make-patch
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const daemonDir = path.resolve(import.meta.dir, '..');
const upstreamDir = path.resolve(daemonDir, '../third_party/proton-drive-sdk/cli/src');
const copyDir = path.join(daemonDir, 'src/proton');
const patchFile = path.join(copyDir, 'kation.patch');

/** Kation's own files in `src/proton/`. */
const KATION_FILES = ['README.md', 'kation.patch'];

/** The only copied files `kation.patch` may change. */
const PATCHED_FILES = ['credentials/constants.ts', 'telemetry/fileHandler.ts'];

/** Upstream paths left out of the copy. A trailing slash means the whole folder. */
const NOT_COPIED: Record<string, string> = {
    'cli/': 'the CLI itself',
    'commands/': 'the CLI commands',
    'init.ts': 'the CLI start-up; Kation has src/drive.ts',
    'proton-drive.ts': 'the CLI entry point',
    'events/index.ts': 'only re-exports; it would pull in events/manager.ts',
    'events/manager.ts': 'uses the deprecated subscribe API, which keeps polling after sign-out; Kation has src/events.ts',
    'events/manager.test.ts': 'test of events/manager.ts',
    'telemetry/index.ts': 'wires the telemetry upload',
    'telemetry/telemetry.ts': 'wires the telemetry upload',
    'telemetry/sentry.ts': 'error upload to Proton',
    'telemetry/sentryHandler.ts': 'error upload to Proton',
    'telemetry/metricHandler.ts': 'metrics upload to Proton',
    'telemetry/metricHandler.test.ts': 'test of telemetry/metricHandler.ts',
    'telemetry/metrics/': 'metrics upload to Proton',
    'telemetry/verifierFileSizeBucket.ts': 'helper of the metrics upload',
    'telemetry/verifierFileSizeBucket.test.ts': 'test of telemetry/verifierFileSizeBucket.ts',
    'telemetry/consoleHandler.ts': 'console output; Kation has src/logging.ts',
    'telemetry/fileHandler.test.ts': 'fakes Bun under Jest, so it cannot run under bun test',
};

class CopyError extends Error {}

async function listFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
        .sort();
}

function notCopiedEntry(file: string): string | undefined {
    return Object.keys(NOT_COPIED).find((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry));
}

async function run(command: string[], cwd: string): Promise<{ exitCode: number; output: string }> {
    const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    return { exitCode, output: stdout + stderr };
}

async function upstreamFiles(): Promise<string[]> {
    if (!existsSync(upstreamDir)) {
        throw new CopyError(`${upstreamDir} is missing. Run: git submodule update --init`);
    }
    const all = await listFiles(upstreamDir);
    const unused = Object.keys(NOT_COPIED).filter((entry) => !all.some((file) => notCopiedEntry(file) === entry));
    if (unused.length > 0) {
        throw new CopyError(`NOT_COPIED lists paths that upstream no longer has: ${unused.join(', ')}`);
    }
    return all.filter((file) => !notCopiedEntry(file));
}

/** Upstream's files with Kation's patch applied, in a new temporary folder. */
async function buildExpected(): Promise<string> {
    const files = await upstreamFiles();
    const patched = [...(await readFile(patchFile, 'utf8')).matchAll(/^(?:---|\+\+\+) (?:[ab]\/)?(\S+)/gm)].map((match) => match[1]);
    const unexpected = [...new Set(patched)].filter((file) => !PATCHED_FILES.includes(file));
    if (unexpected.length > 0) {
        throw new CopyError(`kation.patch changes files other than ${PATCHED_FILES.join(' and ')}: ${unexpected.join(', ')}`);
    }
    // Outside the repository, so that `git apply` treats it as a plain folder.
    const dir = await mkdtemp(path.join(tmpdir(), 'kation-proton-copy-'));
    for (const file of files) {
        await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
        await cp(path.join(upstreamDir, file), path.join(dir, file));
    }
    const { exitCode, output } = await run(['git', '-c', 'apply.whitespace=nowarn', 'apply', '--verbose', patchFile], dir);
    if (exitCode !== 0) {
        await rm(dir, { recursive: true, force: true });
        throw new CopyError(`kation.patch does not apply to upstream:\n${output}`);
    }
    return dir;
}

async function sameContent(a: string, b: string): Promise<boolean> {
    return (await readFile(a)).equals(await readFile(b));
}

async function check(): Promise<void> {
    const expectedDir = await buildExpected();
    try {
        const expected = await listFiles(expectedDir);
        const actual = (await listFiles(copyDir)).filter((file) => !KATION_FILES.includes(file));
        const problems: string[] = [];
        for (const file of expected) {
            if (!actual.includes(file)) {
                problems.push(`${file}: in upstream but not in the copy (copy it, or list it in NOT_COPIED)`);
            } else if (!(await sameContent(path.join(expectedDir, file), path.join(copyDir, file)))) {
                problems.push(`${file}: differs from upstream plus kation.patch`);
            }
        }
        for (const file of actual.filter((file) => !expected.includes(file))) {
            problems.push(`${file}: not from upstream (Kation's code belongs outside src/proton/)`);
        }
        if (problems.length > 0) {
            throw new CopyError(`src/proton/ is not upstream plus kation.patch:\n  ${problems.join('\n  ')}`);
        }
        console.log(`src/proton/: ${expected.length} files match upstream plus kation.patch`);
    } finally {
        await rm(expectedDir, { recursive: true, force: true });
    }
}

async function update(): Promise<void> {
    const expectedDir = await buildExpected();
    try {
        const expected = await listFiles(expectedDir);
        for (const file of await listFiles(copyDir)) {
            if (!expected.includes(file) && !KATION_FILES.includes(file)) {
                await rm(path.join(copyDir, file));
                console.log(`removed ${file}`);
            }
        }
        for (const file of expected) {
            const target = path.join(copyDir, file);
            if (!existsSync(target)) {
                console.log(`added ${file}`);
            } else if (await sameContent(path.join(expectedDir, file), target)) {
                continue;
            } else {
                console.log(`updated ${file}`);
            }
            await mkdir(path.dirname(target), { recursive: true });
            await cp(path.join(expectedDir, file), target);
        }
    } finally {
        await rm(expectedDir, { recursive: true, force: true });
    }
}

/** Diffs only PATCHED_FILES: the rest of the copy may still be an older release. */
async function makePatch(): Promise<void> {
    let patch = '';
    for (const file of PATCHED_FILES) {
        const copied = path.join(copyDir, file);
        const labels = ['--label', `a/${file}`, '--label', `b/${file}`];
        const { exitCode, output } = await run(['diff', '-u', ...labels, path.join(upstreamDir, file), copied], daemonDir);
        if (exitCode > 1) {
            throw new CopyError(`diff failed on ${file}:\n${output}`);
        }
        patch += output;
    }
    await writeFile(patchFile, patch);
    console.log(`wrote ${path.relative(daemonDir, patchFile)}`);
}

const commands: Record<string, () => Promise<void>> = { check, update, 'make-patch': makePatch };
const command = commands[process.argv[2] ?? ''];
if (!command) {
    console.error('Usage: bun ./scripts/protonCopy.ts check | update | make-patch');
    process.exit(2);
}
try {
    await command();
} catch (error: unknown) {
    if (!(error instanceof CopyError)) {
        throw error;
    }
    console.error(error.message);
    process.exit(1);
}
