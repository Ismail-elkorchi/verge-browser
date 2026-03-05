import { execFileSync } from "node:child_process";

function runCommand(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function parseRepoFromRemote(remoteUrl) {
  const scpStyle = remoteUrl.match(/github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (scpStyle) {
    return { owner: scpStyle[1], repo: scpStyle[2] };
  }

  const httpsStyle = remoteUrl.match(/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsStyle) {
    return { owner: httpsStyle[1], repo: httpsStyle[2] };
  }

  throw new Error(`Unable to parse GitHub repository from remote URL: ${remoteUrl}`);
}

function ghApiJson(endpoint) {
  const output = runCommand("gh", [
    "api",
    endpoint,
    "-H",
    "Accept: application/vnd.github+json"
  ]);
  return JSON.parse(output);
}

export function getRepositoryCoordinates() {
  const remoteUrl = runCommand("git", ["config", "--get", "remote.origin.url"]);
  return parseRepoFromRemote(remoteUrl);
}

function resolveDefaultToRef() {
  try {
    const originHead = runCommand("git", ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    return originHead.replace("refs/remotes/origin/", "");
  } catch {
    return "main";
  }
}

export function resolveReleaseRange({ fromTag, toRef } = {}) {
  const resolvedToRef = toRef ?? resolveDefaultToRef();
  let resolvedFromTag = fromTag;

  if (!resolvedFromTag) {
    const mergedTagsOutput = runCommand("git", [
      "tag",
      "--merged",
      resolvedToRef,
      "--sort=-creatordate",
      "--list",
      "v*.*.*"
    ]);
    const mergedTags = mergedTagsOutput.split("\n").map((tag) => tag.trim()).filter(Boolean);

    if (mergedTags.length === 0) {
      throw new Error(`No release tags found that are reachable from ${resolvedToRef}`);
    }

    const pointsAtOutput = runCommand("git", ["tag", "--points-at", resolvedToRef, "--list", "v*.*.*"]);
    const pointsAtTags = new Set(pointsAtOutput.split("\n").map((tag) => tag.trim()).filter(Boolean));
    resolvedFromTag = mergedTags.find((tag) => !pointsAtTags.has(tag)) ?? mergedTags[0];
  }

  return {
    fromTag: resolvedFromTag,
    toRef: resolvedToRef
  };
}

export function listMergedPullRequests({ owner, repo, fromTag, toRef }) {
  const compareEndpoint = `repos/${owner}/${repo}/compare/${encodeURIComponent(fromTag)}...${encodeURIComponent(toRef)}`;
  const compare = ghApiJson(compareEndpoint);
  const commits = Array.isArray(compare.commits) ? compare.commits : [];
  const pullRequestByNumber = new Map();

  for (const commit of commits) {
    if (!commit?.sha) {
      continue;
    }

    const pulls = ghApiJson(`repos/${owner}/${repo}/commits/${commit.sha}/pulls`);
    for (const pull of pulls) {
      if (!pull?.number || !pull?.merged_at) {
        continue;
      }

      pullRequestByNumber.set(pull.number, {
        number: pull.number,
        title: pull.title,
        url: pull.html_url,
        mergedAt: pull.merged_at
      });
    }
  }

  return [...pullRequestByNumber.values()].sort((left, right) => {
    const mergedAtOrder = left.mergedAt.localeCompare(right.mergedAt);
    if (mergedAtOrder !== 0) {
      return mergedAtOrder;
    }
    return left.number - right.number;
  });
}

export function renderPullRequestBullets(pullRequests) {
  if (pullRequests.length === 0) {
    return "- No merged pull requests in this range.";
  }

  return pullRequests
    .map((pullRequest) => `- ${pullRequest.title} ([#${pullRequest.number}](${pullRequest.url}))`)
    .join("\n");
}

export function buildReleaseNotes(options = {}) {
  const { owner, repo } = getRepositoryCoordinates();
  const { fromTag, toRef } = resolveReleaseRange(options);
  const pullRequests = listMergedPullRequests({ owner, repo, fromTag, toRef });
  const bulletList = renderPullRequestBullets(pullRequests);

  return {
    owner,
    repo,
    fromTag,
    toRef,
    pullRequests,
    bulletList,
    markdown: [`### Changes (${fromTag}...${toRef})`, bulletList].join("\n")
  };
}

export function parseReleaseCliArgs(argv) {
  const options = {
    dryRun: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (argument === "--from-tag" || argument === "--from_tag") {
      options.fromTag = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--to-ref" || argument === "--to_ref") {
      options.toRef = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--changelog" || argument === "--changelog-file") {
      options.changelogPath = argv[index + 1];
      index += 1;
      continue;
    }
  }

  return options;
}
