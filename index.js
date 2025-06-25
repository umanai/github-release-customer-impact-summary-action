const { Context } = require("@actions/github/lib/context");
const { Octokit } = require("@octokit/rest");
const core = require("@actions/core");
const updateSection = require("update-section");

const START_LINE = "<!-- START uman-changelog -->";
const END_LINE = "<!-- END uman-changelog -->";

const getRegEx = (text) =>
  new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

const updateBody = (body, template) => {
  const parsedSection = updateSection.parse(
    body.split("\n"),
    (line) => getRegEx("<!-- START uman-changelog ").test(line),
    (line) => getRegEx("<!-- END uman-changelog ").test(line)
  );
  if (!parsedSection.hasStart) {
    return `${body}\n${START_LINE}\n${template}\n${END_LINE}`;
  }

  return updateSection(
    body,
    `${START_LINE}\n${template}\n${END_LINE}`,
    (line) => getRegEx("<!-- START uman-changelog ").test(line),
    (line) => getRegEx("<!-- END uman-changelog ").test(line)
  );
};

const filterPrereleaseCommits = (commits) => {
  return commits
    .filter((commit) => /^Merge pull request #\d+/.test(commit.commit.message))
    .filter(
      (commit) => !/^Merge .+ into development/.test(commit.commit.message)
    );
};

const prereleaseChangelog = (commits) => {
  return filterPrereleaseCommits(commits).map((commit) => {
    const splitMessage = commit.commit.message.split("\n");
    const message = splitMessage[splitMessage.length - 1];
    if (commit.author == undefined || commit.author == null) {
      return `| ${message} | |`;
    }
    return `| ${message} | ${commit.author.login} |)`;
  });
};

const filterPRCommits = (commits) => {
  return commits
    .filter((commit) => !/^Merge pull request #\d+/.test(commit.commit.message))
    .filter(
      (commit) => !/^Merge branch '.+' of .+/.test(commit.commit.message)
    );
};

const prCommits = (commits) => {
  return filterPRCommits(commits).map((commit) => {
    const message = commit.commit.message.split("\n")[0];
    if (commit.author == undefined || commit.author == null) {
      return `| ${message} | ${commit.sha} | |`;
    }
    return `| ${message} | ${commit.sha} | ${commit.author.login} |`;
  });
};

const execute = async (context) => {
  const inputs = {
    githubToken: core.getInput("github_token", { required: true }),
    isPrerelease: core.getBooleanInput("is_prerelease"),
    prBody: core.getInput("pr_body"),
  };

  let prBody = context.payload.pull_request.body;
  if (prBody == undefined || prBody == null) {
    prBody = "";
  }

  const octokit = new Octokit({ auth: inputs.githubToken });
  const allCommits = [];

  const params = {
    ...context.repo,
    pull_number: context.payload.number,
    per_page: 50,
  };
  for await (const response of octokit.paginate.iterator(
    octokit.rest.pulls.listCommits,
    params
  )) {
    const commits = response.data;
    commits.forEach((commit) => allCommits.push(commit));
  }

  const contentFunc = inputs.isPrerelease ? prereleaseChangelog : prCommits;
  const content = contentFunc(allCommits).join("\n");

  const title = inputs.isPrerelease ? "Changelog" : "Commits";
  const header = inputs.isPrerelease
    ? "| PR | Author |\n|--------|--------|"
    : "| Message | ID | Author |\n|--------|--------|--------|";
  const template = `### ${title}\n${header}\n${content}`;

  const newBody = updateBody(prBody, template);
  if (newBody != prBody) {
    await octokit.rest.pulls.update({
      ...context.repo,
      pull_number: context.payload.number,
      body: newBody,
    });
  }
};

const run = async () => {
  const context = new Context();

  await execute(context);
};

run();
