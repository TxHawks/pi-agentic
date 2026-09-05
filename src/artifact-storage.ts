import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export function resolveArtifactProjectRoot(cwd: string): string {
	let dir = resolve(cwd);
	let packageRoot: string | null = null;

	while (true) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		if (!packageRoot && existsSync(join(dir, "package.json"))) {
			packageRoot = dir;
		}

		const parent = dirname(dir);
		if (parent === dir) {
			return packageRoot ?? resolve(cwd);
		}
		dir = parent;
	}
}

export function getArtifactStorageRoot(): string {
	const envRoot = process.env.PI_ARTIFACT_PROJECT_ROOT?.trim();
	return envRoot ? resolve(envRoot) : join(homedir(), ".pi", "history");
}

/**
 * The run artifact root: the one directory that holds every run's durable
 * artifacts, for all projects. The run store creates it with mode 0700 and
 * a format marker.
 */
export function getRunArtifactRoot(artifactRoot: string): string {
	return join(artifactRoot, "runs");
}

export function getArtifactProjectName(cwd: string): string {
	return basename(resolveArtifactProjectRoot(cwd));
}

export function getProjectArtifactsDir(cwd: string): string {
	return join(getArtifactStorageRoot(), getArtifactProjectName(cwd), "artifacts");
}

export function getSessionArtifactDir(cwd: string, sessionId: string): string {
	return join(getProjectArtifactsDir(cwd), sessionId);
}

export function resolveSessionArtifactPath(cwd: string, sessionId: string, name: string): string {
	return resolve(getSessionArtifactDir(cwd, sessionId), name);
}
