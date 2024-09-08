import { existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';

import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import stringArgv from 'string-argv';

import { createRelease } from './create-release';
import { uploadAssets as uploadReleaseAssets } from './upload-release-assets';
import { uploadVersionJSON } from './upload-version-json';
import { buildProject } from './build';
import { execCommand, getInfo, getTargetInfo } from './utils';

import type { Artifact, BuildOptions, InitOptions } from './types';

async function run(): Promise<void> {
  try {
    const projectPath = resolve(
      process.cwd(),
      core.getInput('projectPath') || process.argv[2],
    );
    const distPath = core.getInput('distPath');
    const iconPath = core.getInput('iconPath');
    const appName = core.getInput('appName');
    const appVersion = core.getInput('appVersion');
    const includeRelease = core.getBooleanInput('includeRelease');
    const includeDebug = core.getBooleanInput('includeDebug');
    const includeUpdaterJson = core.getBooleanInput('includeUpdaterJson');
    const updaterJsonKeepUniversal = core.getBooleanInput(
      'updaterJsonKeepUniversal',
    );
    const tauriScript = core.getInput('tauriScript');
    const args = stringArgv(core.getInput('args'));
    const bundleIdentifier = core.getInput('bundleIdentifier');

    let tagName = core.getInput('tagName').replace('refs/tags/', '');
    let releaseId = Number(core.getInput('releaseId'));
    let releaseName = core.getInput('releaseName').replace('refs/tags/', '');
    let body = core.getInput('releaseBody');
    const owner = core.getInput('owner') || context.repo.owner;
    const repo = core.getInput('repo') || context.repo.repo;
    const draft = core.getBooleanInput('releaseDraft');
    const prerelease = core.getBooleanInput('prerelease');
    const commitish = core.getInput('releaseCommitish') || null;

    // TODO: Change its default to true for v2 apps
    // Not using getBooleanInput so we can differentiate between true,false,unset later.
    const updaterJsonPreferNsis =
      core.getInput('updaterJsonPreferNsis')?.toLowerCase() === 'true';

    const buildOptions: BuildOptions = {
      tauriScript,
      args,
    };
    const initOptions: InitOptions = {
      distPath,
      iconPath,
      bundleIdentifier,
      appName,
      appVersion,
    };

    const targetArgIdx = [...args].findIndex(
      (e) => e === '-t' || e === '--target',
    );
    const targetPath =
      targetArgIdx >= 0 ? [...args][targetArgIdx + 1] : undefined;

    const configArgIdx = [...args].findIndex(
      (e) => e === '-c' || e === '--config',
    );
    const configArg =
      configArgIdx >= 0 ? [...args][configArgIdx + 1] : undefined;

    const releaseArtifacts: Artifact[] = [];
    const debugArtifacts: Artifact[] = [];
    if (includeRelease) {
      releaseArtifacts.push(
        ...(await buildProject(projectPath, false, buildOptions, initOptions)),
      );
    }
    if (includeDebug) {
      debugArtifacts.push(
        ...(await buildProject(projectPath, true, buildOptions, initOptions)),
      );
    }
    const artifacts = releaseArtifacts.concat(debugArtifacts);

    if (artifacts.length === 0) {
      if (releaseId || tagName || releaseName) {
        throw new Error('No artifacts were found.');
      } else {
        console.log(
          'No artifacts were found. The action was not configured to upload artifacts, therefore this is not handled as an error.',
        );
        return;
      }
    }

    console.log(`Found artifacts:\n${artifacts.map((a) => a.path).join('\n')}`);
    core.setOutput(
      'artifactPaths',
      JSON.stringify(artifacts.map((a) => a.path)),
    );

    const targetInfo = getTargetInfo(targetPath);
    const info = getInfo(projectPath, targetInfo, configArg);
    core.setOutput('appVersion', info.version);

    // Other steps may benfit from this so we do this whether or not we want to upload it.
    if (targetInfo.platform === 'macos') {
      let i = 0;
      for (const artifact of artifacts) {
        // updater provide a .tar.gz, this will prevent duplicate and overwriting of
        // signed archive
        if (
          artifact.path.endsWith('.app') &&
          !existsSync(`${artifact.path}.tar.gz`)
        ) {
          console.log(
            `Packaging ${artifact.path} directory into ${artifact.path}.tar.gz`,
          );

          await execCommand('tar', [
            'czf',
            `${artifact.path}.tar.gz`,
            '-C',
            dirname(artifact.path),
            basename(artifact.path),
          ]);
          artifact.path += '.tar.gz';
        } else if (artifact.path.endsWith('.app')) {
          // we can't upload a directory
          artifacts.splice(i, 1);
        }
        i++;
      }
    }
    // If releaseId is set we'll use this to upload the assets to.
    // If tagName is set we will try to upload assets to the release associated with the given tagName. If failed, we require releaseName to create a new release.
    // If neither releaseId nor tagName are set we won't try to upload anything at the end.
    if (!releaseId) {
      if (tagName) {
        // Try to get releaseId through tagName. If not found, create the release then
        if (process.env.GITHUB_TOKEN === undefined) {
          throw new Error('GITHUB_TOKEN is required');
        }

        // Get authenticated GitHub client (Ocktokit): https://github.com/actions/toolkit/tree/master/packages/github#usage
        const github = getOctokit(process.env.GITHUB_TOKEN);
        const foundRelease = await github.rest.repos.getReleaseByTag({
          owner,
          repo,
          tag: tagName,
        });
        const release = foundRelease.data;
        console.log(`Found release with tag ${tagName}.`);
        const uploadRes = await uploadReleaseAssets(
          owner,
          repo,
          release.id,
          artifacts,
        );
        if (uploadRes?.status === 201) {
          console.log(
            `Successfully upload assets to release with tag ${tagName}.`,
          );
          if (includeUpdaterJson) {
            await uploadVersionJSON({
              owner,
              repo,
              version: info.version,
              notes: body,
              tagName,
              releaseId: release.id,
              artifacts:
                releaseArtifacts.length !== 0
                  ? releaseArtifacts
                  : debugArtifacts,
              targetInfo,
              updaterJsonPreferNsis,
              updaterJsonKeepUniversal,
            });
          }
          return;
        }

        if (!releaseName) {
          throw new Error(
            '`releaseName` is required if `tagName` is set when creating a release.',
          );
        }

        // If releaseName is specified and there no existing release for tagName, create a release then
        const templates = [
          {
            key: '__VERSION__',
            value: info.version,
          },
        ];

        templates.forEach((template) => {
          const regex = new RegExp(template.key, 'g');
          tagName = tagName.replace(regex, template.value);
          releaseName = releaseName.replace(regex, template.value);
          body = body.replace(regex, template.value);
        });

        const releaseData = await createRelease(
          owner,
          repo,
          tagName,
          releaseName,
          body,
          commitish || undefined,
          draft,
          prerelease,
        );
        releaseId = releaseData.id;
        core.setOutput('releaseUploadUrl', releaseData.uploadUrl);
        core.setOutput('releaseId', releaseData.id.toString());
        core.setOutput('releaseHtmlUrl', releaseData.htmlUrl);
      } else {
        console.log(
          'No releaseId or tagName provided, skipping all uploads...',
        );
      }
    } else {
      // If releaseId is set, upload assets to target release
      await uploadReleaseAssets(owner, repo, releaseId, artifacts);
      if (includeUpdaterJson) {
        await uploadVersionJSON({
          owner,
          repo,
          version: info.version,
          notes: body,
          tagName,
          releaseId,
          artifacts:
            releaseArtifacts.length !== 0 ? releaseArtifacts : debugArtifacts,
          targetInfo,
          updaterJsonPreferNsis,
          updaterJsonKeepUniversal,
        });
      }
    }
  } catch (error) {
    // @ts-expect-error Catching errors in typescript is a headache
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    core.setFailed(error.message);
  }
}

await run();
