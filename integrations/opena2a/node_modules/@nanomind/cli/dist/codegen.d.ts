/**
 * @nanomind/codegen — Artifact Generation
 *
 * Generates CI/CD configuration artifacts for security tooling.
 * 9 artifact types covering all major CI platforms + Docker + ATC.
 */
export type ArtifactType = 'github-action' | 'gitlab-ci' | 'azure-pipelines' | 'circleci' | 'docker-compose' | 'dockerfile' | 'pre-commit' | 'makefile' | 'build-action';
interface ArtifactContext {
    projectName: string;
    projectType: string;
    language: string;
    publisher?: string;
    registryUrl?: string;
}
/**
 * Generate a CI/CD artifact.
 */
export declare function generateArtifact(type: ArtifactType, context: ArtifactContext): string;
/**
 * List all available artifact types.
 */
export declare function listArtifactTypes(): ArtifactType[];
/**
 * Detect the best artifact type for a project.
 */
export declare function detectArtifactType(projectDir: string): ArtifactType;
export {};
