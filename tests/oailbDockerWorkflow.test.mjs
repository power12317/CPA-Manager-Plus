import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const readWorkflow = (name) =>
  parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
const workflow = readWorkflow('docker-oailb-borrow.yml');
const job = workflow.jobs.publish;
const build = job.steps.find((step) => step.uses?.startsWith('docker/build-push-action@'));
const image = 'ghcr.io/power12317/cpa-manager-plus-oailb-borrow';

describe('oailb experimental Docker publishing', () => {
  it('runs on the experimental branch and restricts manual runs to the same fork and branch', () => {
    expect(workflow.on.push.branches).toEqual(['codex/oailb-borrow']);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(job.if).toBe(
      "github.repository == 'power12317/CPA-Manager-Plus' && github.ref == 'refs/heads/codex/oailb-borrow'"
    );
    expect(workflow.on).not.toHaveProperty('pull_request');
    expect(workflow.on.push).not.toHaveProperty('tags');
  });

  it('publishes every tag to a separate package, never the stable image', () => {
    const publishers = job.steps.filter((step) => step.with?.push === true);
    expect(publishers).toHaveLength(1);
    expect(build.with.tags.trim().split('\n')).toEqual([
      `${image}:latest`,
      `${image}:sha-\${{ github.sha }}`,
    ]);
    expect(JSON.stringify(workflow)).not.toMatch(/ghcr\.io\/power12317\/cpa-manager-plus[:@]/);
    expect(readWorkflow('docker-publish.yml').on.push.branches).toEqual(['main']);
  });

  it('builds both architectures from the branch source and records the exact commit', () => {
    expect(build.with.context).toBe('.');
    expect(build.with.file).toBe('Dockerfile.manager-server');
    expect(build.with.platforms.split(',')).toEqual(['linux/amd64', 'linux/arm64']);
    expect(build.with['build-args']).toContain('SOURCE_COMMIT=${{ github.sha }}');
    expect(build.with['build-args']).toContain('VERSION=oailb-borrow-${{ github.sha }}');
    expect(build.with.labels).toContain('org.opencontainers.image.revision=${{ github.sha }}');
  });

  it('keeps package writes and build caches scoped to the experimental publisher', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(workflow.concurrency).toEqual({
      group: 'docker-oailb-borrow',
      'cancel-in-progress': true,
    });
    expect(build.with['cache-from']).toBe('type=gha,scope=oailb-borrow');
    expect(build.with['cache-to']).toBe('type=gha,scope=oailb-borrow,mode=max');
  });
});
